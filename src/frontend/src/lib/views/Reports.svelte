<script>
  // M5 reports: templated HTML/MD reports rendered by Go
  // (trusted templates), with a metrics appendix composed client-side.
  // Acceptance #1: a picked saved metric's table lands under the report.
  import {
    listReportTemplates,
    renderReport,
    listMatches,
    listPlayers,
    getRounds,
    getScoreboard,
    listMetrics,
    getMetricValuesForMatch,
    getMetricComputeState,
    getPlayerRefs,
    subscribeMetricProgress,
    onMetricDone,
    errText,
  } from '../services.js';
  import { readOrder, inSequence } from '../metricorder.js';
  import {
    metricPresentation,
    metricStateTitle,
    liveMetricState,
    metricProgressFrac,
    metricProgressStage,
  } from '../metricstate.js';
  import { listedPlayers } from '../players.js';
  import MatchPicker from '../components/MatchPicker.svelte';
  import PlayerPicker from '../components/PlayerPicker.svelte';
  import TokenSelect from '../components/TokenSelect.svelte';
  import StatusChip from '../components/StatusChip.svelte';
  import HelpButton from '../components/HelpButton.svelte';
  import { downloadText } from '../download.js';
  import * as S from '../strings/index.js';
  import { seed, remember } from '../viewstate.svelte.js';

  let { nav = () => {}, routeId = 0, embedded = false, openDocs = () => {} } = $props();

  // The report selection (template, match, player, round, appendix
  // stats) is view-local state: it restores across navigation through
  // the process-scoped registry (viewstate.svelte.js — flat key; the
  // component serves both the standalone route and Match's embedded
  // tab, one selection pool). URL wins for the context id: routeId
  // below overrides the restored matchId whenever the route carries one,
  // so a deep link never loses to the registry. The composed document
  // and busy/error stay transient and never restore.
  const repSeed = seed('reports', {
    tplId: '',
    matchId: 0,
    steamId: '',
    roundNo: 1,
    // The appendix SELECTION: the picked stat ids as a SET (no
    // duplicates possible — TokenSelect filters the list against it),
    // rendered in the metric-order sequence by the `picked` derivation
    // below. View-local working state like the rest of this view's
    // selection: registry-owned (viewstate), never the URL, never web
    // storage. A fresh key (the retired `rows` picker shape is not
    // migrated — pre-release, wipe-and-rerun is the contract).
    stats: [],
  });
  let templates = $state([]);
  let tplError = $state('');
  let tplId = $state(repSeed.tplId);

  let matches = $state([]);
  let matchId = $state(repSeed.matchId);

  // Route context (#/reports/:id, or the host view's match id when
  // embedded): preselects the target match (and re-seeds if the route id
  // changes while mounted — App's if-branch only remounts on a route
  // NAME change). The list effect below only defaults to the newest match
  // while nothing is selected, so a context id wins over the default;
  // embedded never defaults at all — the passed id is authoritative.
  $effect(() => {
    const rid = routeId;
    if (rid) matchId = rid;
  });
  let players = $state([]);
  let steamId = $state(repSeed.steamId);
  let rounds = $state([]);
  let roundNo = $state(repSeed.roundNo);

  let metrics = $state([]);
  let metricsError = $state('');
  // The match-scope ORDER pref (metricorder; null = absent ⇒ default
  // sequence) — presentation only, never gates the token field.
  let orderPref = $state(null);
  let stats = $state(repSeed.stats); // picked stat ids (a set) — chip order comes from `picked`
  $effect(() => remember('reports', { tplId, matchId, steamId, roundNo, stats }));
  // appendix: metricId → {loading, rows?, error?, metric, unitHasRows}.
  // rows are the CANONICAL read's stored values for THIS match (design
  // §5: a picked metric reads stored rows — no per-toggle query-time
  // run), shaped {id, label, value, n} with the label from the roster
  // read (GetPlayerRefs). `unitHasRows` is the sibling coverage that
  // separates '—' from the behind chip.
  let appendix = $state({});
  // The compute state (id → {state, error}) and the live progress feed:
  // a picked metric with no fresh rows for this match renders its
  // STATE instead of a table (design §5's state machine).
  let metricStates = $state(new Map());
  let metricProgress = $state(new Map());
  let appendixReload = $state(0);
  // appendixGen tags one appendix load sequence (a selection or target
  // change supersedes an in-flight reply — the loadMore/refreshList
  // pattern); non-reactive on purpose.
  let appendixGen = 0;

  $effect(() => subscribeMetricProgress((snap) => (metricProgress = snap)));
  // Completion is the refetch point: metric-done replaced the stored
  // rows (the cache already flushed through services' listener) and
  // moved fresh/behind, so both the state map and the picked set
  // reload — a saved document is a snapshot the user saves again.
  $effect(() =>
    onMetricDone(() => {
      appendixReload += 1;
      loadMetricsList();
    }),
  );

  // The save's error slot: a failed template render OR a failed save
  // lands here (the dialog's cancel is a silent no-op by save.js's
  // contract) — transient, never restored.
  let docError = $state('');
  let rendering = $state(false);

  // The template + match read (mount AND tplError's Retry): ONE error
  // slot is fed by both reads, so it settles only when both do — a retry
  // keeps the previous failure on screen until the outcome is known,
  // then clears (both landed) or replaces it. Fulfilled reads still
  // apply independently (the template grid stays usable when only the
  // match list failed — its empty copy is gated on this error below).
  async function loadTemplates() {
    const [t, m] = await Promise.allSettled([
      listReportTemplates(),
      listMatches('', 'extracted_at', true),
    ]);
    if (t.status === 'fulfilled') {
      templates = t.value || [];
      if (templates.length && !templates.some((x) => x.id === tplId)) {
        tplId = templates[0].id;
      }
    }
    if (m.status === 'fulfilled') {
      const rows = m.value || [];
      matches = rows.filter((row) => row.status === 'ready' || row.status === '');
      if (!matches.length) matches = rows;
      // Default to the newest match only while nothing is selected — a
      // route context id (seeded above) wins over it, and embedded (the
      // Reports tab) never defaults: the passed id is authoritative.
      if (!embedded && !matchId && matches.length) matchId = matches[0].id;
    }
    const failed = [t, m].find((r) => r.status === 'rejected');
    tplError = failed ? errText(failed.reason) : '';
  }

  // The metrics + compute-state read (mount AND metricsError's Retry):
  // both land together so the token field and its readout lines settle
  // from one attempt. Clears only when BOTH land, so the appendix never
  // claims "No custom stats yet" while the previous failure still
  // stands. The match ORDER pref rides the same reload but feeds only
  // the sequence (metricorder) — a failed or absent read falls back to
  // the default sequence, never into the error slot that gates the list.
  async function loadMetricsList() {
    try {
      const [rows, states] = await Promise.all([listMetrics(), getMetricComputeState()]);
      metrics = rows || [];
      metricStates = new Map((states || []).map((s) => [s.metricId, s]));
      metricsError = '';
    } catch (e) {
      metricsError = errText(e);
    }
    readOrder('match')
      .then((o) => (orderPref = o))
      .catch(() => (orderPref = null));
  }

  $effect(() => {
    loadTemplates();
    loadMetricsList();
    listPlayers('')
      .then((rows) => {
        players = listedPlayers(rows) || [];
        if (players.length && !players.some((p) => p.steamId === steamId)) {
          steamId = players[0].steamId;
        }
      })
      .catch(() => {
        /* player picker hidden until it loads */
      });
  });

  $effect(() => {
    const id = matchId;
    if (!id) return;
    getRounds(id)
      .then((rs) => {
        rounds = rs || [];
        // Round-scoped reports address COUNTED rounds only — knife/warmup
        // rounds carry negative numbers, so the clamp runs against the
        // highest positive round rather than the row count.
        const maxRound = (rs || []).reduce((m, r) => Math.max(m, r.number), 0);
        if (roundNo > maxRound) roundNo = Math.max(1, maxRound);
      })
      .catch(() => (rounds = []));
  });

  // Highest counted round (negatives are knife/warmup rounds).
  const maxRound = $derived(rounds.reduce((m, r) => Math.max(m, r.number), 0));

  const tpl = $derived(templates.find((t) => t.id === tplId) || null);

  // Player-scoped targets: the scoreboard of the selected match gives the
  // player picker each candidate's side + in-match stats; the profile list
  // (players) carries career totals for players outside this match. Other
  // scopes never need it, so it is only fetched — and kept — for
  // player-scoped templates.
  //
  // assistsBySteam is the picker's K/D/A triple's A half (design §3.1/Q2):
  // the match-scope `assists` METRIC rows read by NAME beside sbBySteam —
  // the ONE canonical stored read (getMetricValuesForMatch, fresh rows
  // only), resolved through the catalog this view already loads. K and D
  // stay the raw scoreboard fields; a player with no fresh row (absent or
  // behind) renders the honest dash in the A half, never the stored
  // column, never a fabricated 0.
  let sbBySteam = $state({});
  let assistsBySteam = $state(new Map());

  $effect(() => {
    const id = matchId;
    const scope = tpl && tpl.scope;
    if (!id || scope !== 'player') {
      sbBySteam = {};
      assistsBySteam = new Map();
      return;
    }
    let live = true;
    // The catalog lands with loadMetricsList (and reloads on every
    // metric-done — the sweep that replaced these rows), so reading it
    // here both fills the half once the definitions are known and
    // refetches when a sweep moves the rows.
    const assistsDef = (metrics || []).find(
      (d) => d && d.name === 'assists' && (d.scope || 'match') === 'match',
    );
    Promise.all([
      getScoreboard(id, '', false),
      assistsDef ? getMetricValuesForMatch(id, [assistsDef.id]) : Promise.resolve([]),
    ])
      .then(([rows, values]) => {
        if (!live) return;
        const m = {};
        for (const r of listedPlayers(rows) || []) m[r.steamId] = r;
        sbBySteam = m;
        const a = new Map();
        if (assistsDef) {
          for (const v of values || []) {
            if (v.metricId === assistsDef.id) a.set(v.steamId, { value: v.value, format: assistsDef.format });
          }
        }
        assistsBySteam = a;
      })
      .catch(() => {
        if (live) {
          sbBySteam = {};
          assistsBySteam = new Map();
        }
      });
    return () => (live = false);
  });

  // The metric catalog on offer is FLAT and match-scope only (design §5:
  // the Reports appendix is a per-match document — profile-scope metrics
  // surface on PlayerProfile, and the groupBy grouping died with the W2
  // grammar wave: every table is "per player"). It feeds the token field
  // in the match ORDER sequence (lib/metricorder.js — the one ordering
  // mechanism): scope-filtered catalog in sequence order, absent pref ⇒
  // the default sequence (catalog order over the unranked). The pins
  // array never orders this list — the appendix selection is the set's
  // own.
  const matchMetrics = $derived(inSequence('match', orderPref, metrics));

  // --- The appendix selection (a SET of stat ids) ---------------------------
  // `stats` is the set; `picked` is its RENDER — the catalog filtered to
  // it, which is exactly the metric-order sequence, so the chips read in
  // the same order the exported document's sections do (and the token
  // field can never re-offer a picked stat: TokenSelect filters its list
  // against `tokens`, so no duplicate can form).
  const metricText = (m) => m.title || m.name;
  const picked = $derived(matchMetrics.filter((m) => stats.includes(m.id)));

  // addStat/removeStat write the SET (idempotent — the list is already
  // filtered, this is the belt to its braces).
  function addStat(m) {
    if (!stats.includes(m.id)) stats = [...stats, m.id];
  }

  function removeStat(id) {
    stats = stats.filter((x) => x !== id);
  }

  // ONE stored read for the whole picked set (design §5: no per-toggle
  // query-time run): re-runs whenever the target, the selection, the
  // definition list or a metric-done completion changes it. Each picked
  // id that still resolves to a definition gets an entry — an id whose
  // metric is gone drops out (deleted metrics never render), and a
  // picked metric with no stored row for this match keeps an honest
  // empty row list (the state decides what renders, never a 0).
  $effect(() => {
    const gen = ++appendixGen;
    const mid = matchId;
    appendixReload; // spectra:metric-done → refetch (the cache flushed)
    const defs = new Map(metrics.map((m) => [m.id, m]));
    const sel = stats.filter((id) => defs.has(id)).sort((a, b) => a - b);
    if (!sel.length) {
      appendix = {};
      return;
    }
    const pending = {};
    for (const id of sel) pending[id] = { loading: true, metric: defs.get(id) };
    appendix = pending;
    Promise.all([getMetricValuesForMatch(mid, sel), getPlayerRefs(mid)])
      .then(([values, refs]) => {
        if (gen !== appendixGen) return;
        const bySteam = new Map((refs || []).map((r) => [r.steamId, r.name]));
        const byMetric = new Map();
        for (const v of values || []) {
          if (!byMetric.has(v.metricId)) byMetric.set(v.metricId, []);
          byMetric.get(v.metricId).push(v);
        }
        const next = {};
        for (const id of sel) {
          const valRows = (byMetric.get(id) || []).map((v) => ({
            id: v.steamId,
            label: bySteam.get(v.steamId) || v.steamId,
            value: v.value,
            n: v.n,
          }));
          next[id] = {
            loading: false,
            rows: valRows,
            metric: defs.get(id),
            unitHasRows: valRows.length > 0,
          };
        }
        appendix = next;
      })
      .catch((e) => {
        if (gen !== appendixGen) return;
        const next = {};
        for (const id of sel) {
          next[id] = { loading: false, error: errText(e), metric: defs.get(id) };
        }
        appendix = next;
      });
  });

  // THE state machine for one appendix entry (lib/metricstate.js,
  // design §5): the live progress feed wins, then value / '—' / chip.
  // A value-kind entry carries its rows; everything else renders the
  // state word.
  function appendixPres(id) {
    const a = appendix[id];
    if (!a || a.loading || a.error) return null;
    // Number(): Object.entries hands the id over as a STRING key while
    // the state/progress Maps key by NUMBER — a raw '3' would miss every
    // Map and render the unknown-state dash.
    const key = Number(id);
    const st = liveMetricState(metricProgress, metricStates, key);
    const row = a.rows && a.rows.length ? a.rows[0] : null;
    return metricPresentation(st, row, a.unitHasRows);
  }

  // The row indicator: fresh → the honest row count; any other
  // state → the state chip (StatusChip — the ONE widget; the ms chip is
  // gone: timing was never provenance). The chip's title is the state
  // copy (failed carries the compute error, never a stamp).
  function appendixChip(id) {
    const pres = appendixPres(id);
    if (!pres) return null;
    if (pres.kind === 'value') return { kind: 'rows', n: appendix[id].rows.length };
    const state = pres.kind === 'nodata' ? 'no-data' : pres.state;
    const st = metricStates.get(id);
    return { kind: 'state', state, title: metricStateTitle(state, st && st.error) };
  }

  function fmtVal(v) {
    if (!Number.isFinite(v)) return '—';
    return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function targetReady() {
    if (!tpl) return false;
    if (tpl.scope === 'player') return !!steamId;
    if (tpl.scope === 'round') return !!matchId && roundNo >= 1;
    return !!matchId;
  }

  // The filename the save dialog opens with: the template's title
  // slugged, the target it addresses, and the extension the template's
  // own format dictates (the download helper derives the dialog's
  // extension from it).
  function reportFilename() {
    const base =
      String((tpl && (tpl.title || tpl.id)) || 'report')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'report';
    const target =
      tpl.scope === 'player' ? steamId : tpl.scope === 'round' ? `round-${roundNo}` : `match-${matchId}`;
    return `${base}-${target}.${(tpl.format || 'md') === 'html' ? 'html' : 'md'}`;
  }

  // Save (was "generate + preview"): render the Go template, compose the
  // client-side appendix onto it (compositeText — the export pipeline
  // below), and land the whole document through the native save dialog
  // (downloadText → save.js; cancel resolves "" and stays silent, a
  // genuine failure lands in docError). The appendix goes WITH the file
  // because the composition happens here — the /api/export route never
  // sees it.
  async function render() {
    rendering = true;
    docError = '';
    try {
      const text = await renderReport(
        tplId,
        matchId,
        tpl && tpl.scope === 'player' ? steamId : '',
        tpl && tpl.scope === 'round' ? roundNo : 0,
      );
      const body = text || '';
      const html = (tpl.format || 'md') === 'html';
      await downloadText(reportFilename(), html ? 'text/html' : 'text/markdown', compositeText(body));
    } catch (e) {
      docError = errText(e);
    } finally {
      rendering = false;
    }
  }

  // --- Metrics appendix ------------------------------------------------------
  // THE section order of the exported document — appendixEntries is the
  // ONE list appendixMd/appendixHtml walk (the W4 addendum to W1:
  // design §2.5's intent — a document is read top-down in the order the
  // surface renders its metrics, so the exported appendix follows the
  // match SEQUENCE, not the selection's id-ASC build order). matchMetrics
  // IS that sequence (metricorder.inSequence — the one ordering
  // mechanism); an entry whose metric fell out of it (scope filter, a
  // definition the catalog no longer lists) trails, id-ASC.
  function appendixEntries() {
    const rank = new Map(matchMetrics.map((m, i) => [m.id, i]));
    return Object.entries(appendix)
      .filter(([, a]) => !a.loading && !a.error && a.rows && a.metric)
      .sort(([a], [b]) => {
        const ra = rank.get(Number(a));
        const rb = rank.get(Number(b));
        if (ra === undefined && rb === undefined) return Number(a) - Number(b);
        if (ra === undefined) return 1;
        if (rb === undefined) return -1;
        return ra - rb;
      });
  }

  // The per-metric meta line: fresh rows → "per player · N rows" (the
  // design §5 copy — the groupBy line and the `· N ms` timing are gone:
  // timing was never provenance); any other state → the honest
  // "value not computed" line with the state word. No stamp, no
  // timestamp, ever (design §5's export pin).
  function appendixLine(id, a) {
    const pres = appendixPres(id);
    if (pres && pres.kind === 'value') {
      return `per player · ${a.rows.length} rows · match #${matchId}`;
    }
    // A chip presentation carries the state word; the neutral dash means
    // the state had not landed — 'no-data' is the honest reading there.
    const word = pres && pres.kind === 'chip' ? pres.state : 'no-data';
    return `value not computed — ${word}`;
  }

  function appendixMd() {
    const ents = appendixEntries();
    if (!ents.length) return '';
    let out = '\n\n## Stats appendix\n\n';
    for (const [id, a] of ents) {
      out += `### ${a.metric.title || a.metric.name}\n\n`;
      out += `${appendixLine(id, a)}\n\n`;
      if ((appendixPres(id) || {}).kind !== 'value') continue;
      out += '| Group | Label | Value | n |\n|---|---|---|---|\n';
      for (const r of a.rows) {
        out += `| ${mdCell(r.id)} | ${mdCell(r.label)} | ${fmtVal(r.value)} | ${r.n} |\n`;
      }
      out += '\n';
    }
    return out;
  }

  function mdCell(s) {
    return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  }

  function appendixHtml() {
    const ents = appendixEntries();
    if (!ents.length) return '';
    let out = '<section class="rep-appendix-doc"><h2>Stats appendix</h2>';
    for (const [id, a] of ents) {
      out += `<h3>${esc(a.metric.title || a.metric.name)}</h3>`;
      out += `<p>${esc(appendixLine(id, a))}</p>`;
      if ((appendixPres(id) || {}).kind !== 'value') continue;
      out += '<table class="data-table mini"><thead><tr><th>Group</th><th>Label</th><th class="num">Value</th><th class="num">n</th></tr></thead><tbody>';
      for (const r of a.rows) {
        out += `<tr><td>${esc(r.id)}</td><td>${esc(r.label)}</td><td class="num">${fmtVal(r.value)}</td><td class="num">${r.n}</td></tr>`;
      }
      out += '</tbody></table>';
    }
    out += '</section>';
    return out;
  }

  // The Go templates are ours (trusted) — the appendix is built from
  // server data + escaped text, so concatenation is safe. `body` is the
  // rendered template: with no appendix entries the file IS the body.
  function compositeText(body) {
    const ents = appendixEntries();
    if (!ents.length) return body;
    if ((tpl && tpl.format) === 'html') return body + appendixHtml();
    return body + appendixMd();
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
</script>

<div class="view">
  {#if !embedded}
    <header class="view-header">
      <h1>{S.reports.title}</h1>
      <span class="muted">{S.reports.subtitle}</span>
      <!-- Standalone only: embedded (Match's Reports tab) the header
           does not render — Match's own header `?` covers that tab
           (MATCH_TAB_SECTIONS → reports). One `?`, primary chrome. -->
      <div class="spacer"></div>
      <HelpButton section="reports" {openDocs} />
    </header>
  {/if}

  {#if tplError}
    <p class="error" role="alert">
      {tplError}
      <button class="btn small" onclick={loadTemplates}>{S.reports.retry}</button>
    </p>
  {/if}

  <section class="panel">
    <div class="row-between">
      <h2>{S.reports.templateAndTarget}</h2>
      <!-- Save lives with its inputs: template + target pick the scope,
           this button produces the document they both address and hands
           it to the save dialog. The busy shape is pinned by
           progress-presentation.dom.mjs — a save that renders the body
           first is still "Generating…". -->
      <button class="btn primary" disabled={rendering || !targetReady()} onclick={render}>
        {#if rendering}Generating…{:else}{S.reports.generateReport}<span class="codicon codicon-play"></span>{/if}
      </button>
    </div>
    {#if docError}
      <!-- The one error slot for render + save (cancel stays silent). -->
      <p class="error" role="alert">{docError}</p>
    {/if}
    <div class="rep-tpl-grid">
      {#each templates as t (t.id)}
        <button
          class="rep-tpl"
          class:active={tplId === t.id}
          aria-pressed={tplId === t.id}
          onclick={() => {
            tplId = t.id;
            docError = '';
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
        {#if !tplError}
          <!-- Gated on tplError: a failed template/match read is UNKNOWN,
               never "no templates" — the alert above carries it. -->
          <p class="muted" role="status">{S.reports.noTemplates}</p>
        {/if}
      {/each}
    </div>
    {#if tpl}
      <div class="rep-targets">
        {#if !embedded && matches.length === 0 && !tplError}
          <p class="muted" role="status">{S.reports.noMatches}</p>
        {/if}
        {#if embedded}
          <p class="muted" role="status">{S.reports.targetThisMatch}</p>
        {/if}
        {#if !embedded}
          <div class="rep-field">
            <label class="field-label" for="rep-match">{S.reports.matchLabel}</label>
            <MatchPicker
              {matches}
              value={matchId}
              id="rep-match"
              onselect={(mid) => (matchId = mid)}
            />
          </div>
        {/if}
        {#if tpl.scope === 'player'}
          <div class="rep-field">
            <label class="field-label" for="rep-player">{S.reports.playerLabel}</label>
            <PlayerPicker
              {players}
              stats={sbBySteam}
              assists={assistsBySteam}
              value={steamId}
              id="rep-player"
              onselect={(sid) => (steamId = sid)}
            />
          </div>
        {/if}
        {#if tpl.scope === 'round'}
          <div class="rep-field">
            <label class="field-label" for="rep-round">{S.reports.roundLabel}</label>
            <input
              class="input"
              id="rep-round"
              type="number"
              min="1"
              max={Math.max(1, maxRound)}
              bind:value={roundNo}
            />
            <span class="muted rep-hint">1..{Math.max(1, maxRound)}</span>
          </div>
        {/if}
      </div>
    {/if}
  </section>

  {#if tpl}
    <!-- Stats appendix (acceptance #1: a picked metric → table under the report). -->
    <section class="panel">
      <h2>{S.reports.statsAppendix}</h2>
      {#if metricsError}
        <p class="error" role="alert">
          {metricsError}
          <button class="btn small" onclick={loadMetricsList}>{S.reports.retry}</button>
        </p>
      {/if}
      <p class="muted">
        {S.reports.appendixHint}
      </p>
      {#if matchMetrics.length === 0}
        {#if !metricsError}
          <!-- Gated on metricsError: a failed listMetrics read is UNKNOWN,
               never "no custom stats" — the alert above carries it. -->
          <p class="muted" role="status">
            {metrics.length
              ? S.reports.noMatchScopedStats
              : S.reports.noCustomStats}
          </p>
        {/if}
      {:else}
        <!-- One field, not N rows: type to search, pick → a chip (the
             set of ids lives in `stats`; TokenSelect renders it in the
             metric-order sequence). -->
        <TokenSelect
          id="rep-stats"
          items={matchMetrics}
          text={metricText}
          tokens={picked.map((m) => ({ id: m.id, label: metricText(m) }))}
          placeholder={S.reports.metricHint}
          ariaLabel={S.reports.metricAria}
          removeAria={S.reports.removeStatAria}
          align="start"
          onselect={addStat}
          onremove={removeStat}
        />
        <!-- The per-picked-stat readout: the honesty line each stat
             earns — expression, row count or STATE chip (never a
             fabricated number), in the same sequence as its chip. -->
        {#each picked as m (m.id)}
          <div class="rep-metric">
            <strong>{metricText(m)}</strong>
            <span class="muted mono rep-metric-expr">{m.expr}</span>
            {#if appendix[m.id] && appendix[m.id].loading}
              <span class="muted">…</span>
            {:else if appendix[m.id] && appendix[m.id].error}
              <span class="error-text" title={appendix[m.id].error}>{S.reports.failedLabel}</span>
            {:else}
              {@const chip = appendixChip(m.id)}
              {#if chip && chip.kind === 'rows'}
                <span class="chip">{chip.n}{S.reports.rowsSuffix}</span>
              {:else if chip}
                <!-- State in lieu of rows (design §5): processing /
                     failed / behind / no-data through StatusChip. -->
                <StatusChip
                  status={chip.state}
                  title={chip.title}
                  progress={metricProgressFrac(metricProgress, m.id)}
                  stage={metricProgressStage(metricProgress, m.id)}
                />
              {/if}
            {/if}
          </div>
        {/each}
      {/if}
    </section>
  {/if}
</div>

<style>
  /* The appendix (rep-): the token field spans the panel (its own
     full-width .tk), then one readout row per picked stat — the row
     keeps the .rep-metric concept class (one stat's line — global
     style-m3b.css still contributes the expr ellipsis and the wrap). */
  .rep-metric {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 6px;
  }
</style>
