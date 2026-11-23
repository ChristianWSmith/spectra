<script>
  // The Reports template and target panel (builtin, composed by ReportsView):
  // the template grid, the target pickers (a player for a player template, a
  // round for a round template) and the one error slot for the template read
  // and the save. The match is the context's; the Match tab shows it as the
  // target, and the standalone route picks it above this panel.
  import { getScoreboard, getMetricValuesForMatch } from '../../services.js';
  import { listedPlayers } from '../../players.js';
  import PlayerPicker from '../../components/PlayerPicker.svelte';
  import * as S from '../../strings/index.js';
  import { findTemplate } from './shared.js';

  let { spectra, context, m, embedded = false } = $props();

  const matchId = $derived(context.matchId || 0);
  const tpl = $derived(findTemplate(m.templates, m.tplId));
  const maxRound = $derived(m.rounds.reduce((x, r) => Math.max(x, r.number), 0));

  // Player-scoped targets: the scoreboard of the match gives the picker each
  // candidate's side (identity only); every statline half is a stored seed row
  // (the match-scope seeds, fresh rows only), so a missing half is the dash.
  const STATLINE_SEEDS = ['kills', 'deaths', 'assists', 'adr', 'rounds_played'];

  $effect(() => {
    const id = matchId;
    const scope = tpl && tpl.scope;
    if (!id || scope !== 'player') {
      m.sbBySteam = {};
      m.seeds = new Map();
      return;
    }
    let live = true;
    const catalog = new Map((m.metrics || []).filter((d) => d && d.name).map((d) => [d.name, d]));
    const matchDefs = STATLINE_SEEDS.map((n) => catalog.get(n)).filter((d) => d && (d.scope || 'match') === 'match');
    const out = new Map(matchDefs.map((d) => [d.name, { def: d, bySteam: new Map() }]));
    spectra.track(Promise.all([
      getScoreboard(id, '', false),
      matchDefs.length ? getMetricValuesForMatch(id, matchDefs.map((d) => d.id)) : Promise.resolve([]),
    ]))
      .then(([rows, values]) => {
        if (!live) return;
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
        if (live) {
          m.sbBySteam = {};
          m.seeds = new Map();
        }
      });
    return () => (live = false);
  });
</script>

<section class="panel" class:builtin-busy={spectra.busy} aria-busy={spectra.busy}>
  <h2>{S.reports.templateAndTarget}</h2>
  {#if m.docError}
    <!-- The one error slot for render + save (cancel stays silent). -->
    <p class="error" role="alert">{m.docError}</p>
  {/if}
  {#if m.tplError}
    <p class="error" role="alert">
      {m.tplError}
      <button class="btn small" onclick={() => m.actions.loadTemplates()}>{S.reports.retry}</button>
    </p>
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
</section>
