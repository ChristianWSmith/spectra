<script>
  // M5 reports: templated HTML/MD reports rendered by Go
  // (trusted templates), with a metrics appendix composed client-side.
  // Acceptance #1: a checked saved metric's table lands under the report.
  import {
    listReportTemplates,
    renderReport,
    reportDownloadURL,
    listMatches,
    listPlayers,
    getRounds,
    getScoreboard,
    listMetrics,
    previewMetric,
  } from '../services.js';
  import { saveText, saveExportURL } from '../save.js';
  import MatchPicker from '../components/MatchPicker.svelte';
  import PlayerPicker from '../components/PlayerPicker.svelte';

  let { nav = () => {} } = $props();

  let templates = $state([]);
  let tplError = $state('');
  let tplId = $state('');

  let matches = $state([]);
  let matchId = $state(0);
  let players = $state([]);
  let steamId = $state('');
  let rounds = $state([]);
  let roundNo = $state(1);

  let metrics = $state([]);
  let metricsError = $state('');
  let checked = $state({}); // metricId → true (appendix selection)
  let appendix = $state({}); // metricId → {loading, rows?, error?, metric, groupBy}

  let doc = $state(''); // rendered report text
  let docError = $state('');
  let rendering = $state(false);

  $effect(() => {
    listReportTemplates()
      .then((rows) => {
        templates = rows || [];
        if (templates.length && !templates.some((t) => t.id === tplId)) {
          tplId = templates[0].id;
        }
      })
      .catch((e) => (tplError = errText(e)));
    listMatches('', 'extracted_at', true)
      .then((rows) => {
        matches = (rows || []).filter((m) => m.status === 'ready' || m.status === '');
        if (!matches.length) matches = rows || [];
        if (matches.length && !matches.some((m) => m.id === matchId)) {
          matchId = matches[0].id;
        }
      })
      .catch((e) => (tplError = tplError || errText(e)));
    listMetrics()
      .then((rows) => (metrics = rows || []))
      .catch((e) => (metricsError = errText(e)));
    listPlayers('')
      .then((rows) => {
        players = rows || [];
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
  let sbBySteam = $state({});

  $effect(() => {
    const id = matchId;
    const scope = tpl && tpl.scope;
    if (!id || scope !== 'player') {
      sbBySteam = {};
      return;
    }
    let live = true;
    getScoreboard(id, '', false)
      .then((rows) => {
        if (!live) return;
        const m = {};
        for (const r of rows || []) m[r.steamId] = r;
        sbBySteam = m;
      })
      .catch(() => {
        if (live) sbBySteam = {};
      });
    return () => (live = false);
  });

  function errText(e) {
    if (e == null) return 'unknown error';
    if (typeof e === 'string') return e;
    return e.message || String(e);
  }

  // Group the metric checkbox list by groupBy (player/round/team/…).
  const metricGroups = $derived.by(() => {
    const g = new Map();
    for (const m of metrics) {
      const k = m.groupBy || 'ungrouped';
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(m);
    }
    return [...g.entries()];
  });

  async function toggleMetric(m) {
    const id = m.id;
    const next = { ...checked };
    if (next[id]) {
      delete next[id];
      checked = next;
      const ap = { ...appendix };
      delete ap[id];
      appendix = ap;
      return;
    }
    next[id] = true;
    checked = next;
    const ap = { ...appendix, [id]: { loading: true, metric: m, groupBy: m.groupBy } };
    appendix = ap;
    try {
      const pv = await previewMetric(id, '', m.groupBy, `match:${matchId}`);
      appendix = {
        ...appendix,
        [id]: {
          loading: false,
          rows: (pv && pv.rows) || [],
          ms: pv ? pv.ms : 0,
          metric: m,
          groupBy: (pv && pv.metric && pv.metric.groupBy) || m.groupBy,
          truncated: pv ? !!pv.truncated : false,
        },
      };
    } catch (e) {
      appendix = {
        ...appendix,
        [id]: { loading: false, error: errText(e), metric: m, groupBy: m.groupBy },
      };
    }
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

  async function render() {
    rendering = true;
    docError = '';
    doc = '';
    try {
      const text = await renderReport(
        tplId,
        matchId,
        tpl && tpl.scope === 'player' ? steamId : '',
        tpl && tpl.scope === 'round' ? roundNo : 0,
      );
      doc = text || '';
    } catch (e) {
      docError = errText(e);
    } finally {
      rendering = false;
    }
  }

  // --- Metrics appendix ------------------------------------------------------
  function appendixEntries() {
    return Object.entries(appendix).filter(([, a]) => !a.loading && !a.error && a.rows);
  }

  function appendixMd() {
    const ents = appendixEntries();
    if (!ents.length) return '';
    let out = '\n\n## Metrics appendix\n\n';
    for (const [, a] of ents) {
      out += `### ${a.metric.title || a.metric.name}\n\n`;
      out += `group by ${a.groupBy || 'none'} · ${a.rows.length} rows · match #${matchId}`;
      if (a.truncated) out += ' · truncated';
      out += ` · ${a.ms} ms\n\n`;
      out += '| Group | Label | Value | n |\n|---|---|---|---|\n';
      for (const r of a.rows) {
        out += `| ${mdCell(r.group)} | ${mdCell(r.label)} | ${fmtVal(r.value)} | ${r.n} |\n`;
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
    let out = '<section class="rep-appendix-doc"><h2>Metrics appendix</h2>';
    for (const [, a] of ents) {
      out += `<h3>${esc(a.metric.title || a.metric.name)}</h3>`;
      out += `<p>group by ${esc(a.groupBy || 'none')} · ${a.rows.length} rows · match #${matchId}${a.truncated ? ' · truncated' : ''} · ${a.ms} ms</p>`;
      out += '<table class="data-table mini"><thead><tr><th>Group</th><th>Label</th><th class="num">Value</th><th class="num">n</th></tr></thead><tbody>';
      for (const r of a.rows) {
        out += `<tr><td>${esc(r.group)}</td><td>${esc(r.label)}</td><td class="num">${fmtVal(r.value)}</td><td class="num">${r.n}</td></tr>`;
      }
      out += '</tbody></table>';
    }
    out += '</section>';
    return out;
  }

  // The Go templates are ours (trusted) — the appendix is built from
  // server data + escaped text, so concatenation is safe.
  function compositeText() {
    const ents = appendixEntries();
    if (!ents.length) return doc;
    if ((tpl && tpl.format) === 'html') return doc + appendixHtml();
    return doc + appendixMd();
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Save the rendered document (report + appendix when one is checked)
  // through the native save dialog (lib/save.js). Cancel resolves to ""
  // and does nothing; a dialog/write failure reports in docError below the
  // preview (the view's error slot).
  async function download() {
    const fmt = (tpl && tpl.format) || 'md';
    const ext = fmt === 'html' ? 'html' : 'md';
    const scope = (tpl && tpl.scope) || 'match';
    const target = scope === 'player' ? steamId || 'player' : matchId;
    docError = '';
    try {
      await saveText(
        `spectra-${scope}-${target}.${ext}`,
        ext,
        compositeText(),
        ext === 'html' ? 'text/html;charset=utf-8' : 'text/markdown;charset=utf-8',
      );
    } catch (e) {
      docError = errText(e);
    }
  }

  // "Open raw" target: only the Go-rendered document (no appendix, and no
  // Render needed — the endpoint renders on demand). Template ids may
  // already carry an extension (match.md), which the Go exporter uses as-is.
  function rawTarget() {
    const fmt = (tpl && tpl.format) || 'md';
    const base = String(tplId || 'report');
    const dot = base.lastIndexOf('.');
    const ext = dot > 0 ? base.slice(dot + 1) : fmt === 'html' ? 'html' : 'md';
    const name = dot > 0 ? `spectra-${matchId}-${base}` : `spectra-${matchId}-${base}.${ext}`;
    return { name, ext };
  }

  // Open raw: the URL rides SaveExport (lib/save.js) — the native dialog
  // picks the path, Go fetches /api/export/… itself and writes it there.
  async function saveRaw() {
    docError = '';
    const { name, ext } = rawTarget();
    try {
      await saveExportURL(reportDownloadURL(matchId, tplId, tpl.format || 'md'), name, ext);
    } catch (e) {
      docError = errText(e);
    }
  }

  // Copy library DB: URL-served (~19 MB SQLite) → SaveExport streams it
  // straight to the dialog path; Go checkpoints the WAL on the way. Never
  // round-trips the bindings as base64.
  async function saveLibraryDb() {
    docError = '';
    try {
      await saveExportURL('/api/export/library.db', 'spectra-library.db', 'db');
    } catch (e) {
      docError = errText(e);
    }
  }

  const hasAppendix = $derived(appendixEntries().length > 0);
</script>

<div class="view">
  <header class="view-header">
    <h1>Reports</h1>
    <span class="muted">Templated match / player / round reports.</span>
  </header>

  {#if tplError}
    <p class="error" role="alert">{tplError}</p>
  {/if}

  <section class="panel">
    <h2>Template</h2>
    <div class="rep-tpl-grid">
      {#each templates as t (t.id)}
        <button
          class="rep-tpl"
          class:active={tplId === t.id}
          aria-pressed={tplId === t.id}
          onclick={() => {
            tplId = t.id;
            doc = '';
          }}
        >
          <span class="rep-tpl-title">{t.title}</span>
          <span class="rep-tpl-meta">
            <span class="chip">{t.scope}</span>
            <span class="chip">{t.format}</span>
            <span class="chip flag" title="Origin">{t.origin || 'builtin'}</span>
          </span>
        </button>
      {:else}
        <p class="muted">No report templates available.</p>
      {/each}
    </div>
  </section>

  {#if tpl}
    <section class="panel">
      <h2>Target</h2>
      <div class="rep-targets">
        {#if matches.length === 0}
          <p class="muted">No matches in the library yet.</p>
        {/if}
        <div class="rep-field">
          <label for="rep-match">Match</label>
          <MatchPicker
            {matches}
            value={matchId}
            id="rep-match"
            onselect={(mid) => (matchId = mid)}
          />
        </div>
        {#if tpl.scope === 'player'}
          <div class="rep-field">
            <label for="rep-player">Player</label>
            <PlayerPicker
              {players}
              stats={sbBySteam}
              value={steamId}
              id="rep-player"
              onselect={(sid) => (steamId = sid)}
            />
          </div>
        {/if}
        {#if tpl.scope === 'round'}
          <div class="rep-field">
            <label for="rep-round">Round</label>
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
    </section>

    <!-- Metrics appendix (acceptance #1: checked metric → table under the report). -->
    <section class="panel">
      <h2>Metrics appendix</h2>
      {#if metricsError}
        <p class="error" role="alert">{metricsError}</p>
      {/if}
      <p class="muted">
        Check metrics to append their tables under the report (scoped to this
        match). Download composes report + appendix; “Open raw” saves only the
        Go-rendered document (native file dialog). “Copy library DB” writes a
        snapshot of the whole library SQLite file.
      </p>
      {#each metricGroups as [group, rows] (group)}
        <div class="rep-mgroup">
          <h3 class="sett-sub">by {group}</h3>
          {#each rows as m (m.id)}
            <label class="filt-check rep-metric">
              <input
                type="checkbox"
                checked={!!checked[m.id]}
                onchange={() => toggleMetric(m)}
              />
              <span>{m.title || m.name}</span>
              <span class="muted mono rep-metric-expr">{m.expr}</span>
              {#if appendix[m.id] && appendix[m.id].loading}
                <span class="muted">…</span>
              {:else if appendix[m.id] && appendix[m.id].error}
                <span class="error-text" title={appendix[m.id].error}>failed</span>
              {:else if appendix[m.id] && appendix[m.id].rows}
                <span class="chip">{appendix[m.id].rows.length} rows</span>
              {/if}
            </label>
          {/each}
        </div>
      {:else}
        <p class="muted">No metrics defined yet — build one in the Builder.</p>
      {/each}
    </section>

    <section class="panel">
      <h2>Preview</h2>
      <div class="row-between">
        <span class="muted"
          >{tpl.title} · {tpl.scope} · {tpl.format}{hasAppendix ? ' + appendix' : ''}</span
        >
        <span class="rep-actions">
          <button class="btn primary" disabled={rendering || !targetReady()} onclick={render}
            >{rendering ? 'Rendering…' : 'Render'}</button
          >
          <button class="btn" disabled={!doc || !targetReady()} onclick={download}
            >Download {hasAppendix ? '(composite)' : `.${tpl.format === 'html' ? 'html' : 'md'}`}</button
          >
          {#if !hasAppendix}
            <button class="btn" onclick={saveRaw}>Open raw</button>
          {:else}
            <span class="muted rep-raw-note" title="Appendix is composed client-side — use Download"
              >Open raw unavailable with appendix</span
            >
          {/if}
          <button class="btn" onclick={saveLibraryDb}>Copy library DB</button>
        </span>
      </div>
      {#if docError}
        <p class="error" role="alert">{docError}</p>
      {/if}
      {#if doc}
        {#if (tpl.format || 'md') === 'html'}
          <!-- Go templates are authored in-repo (trusted) — rendered as HTML. -->
          <div class="rep-html">{@html compositeText()}</div>
        {:else}
          <pre class="rep-md">{compositeText()}</pre>
        {/if}
      {:else if !rendering}
        <p class="muted">Press Render to generate the report.</p>
      {/if}
    </section>
  {/if}
</div>
