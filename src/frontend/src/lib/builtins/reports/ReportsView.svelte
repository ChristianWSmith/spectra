<script>
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
  import {
    listReportTemplates,
    listPlayers,
    getRounds,
    listMetrics,
    getMetricComputeState,
    subscribeMetricProgress,
    onMetricDone,
    errText,
  } from '../../services.js';
  // (getScoreboard is read by the template panel's player picker, not here.)
  import { listedPlayers } from '../../players.js';
  import { seed, remember } from '../../viewstate.svelte.js';

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
    metricProgress: new Map(),
    reload: 0,
    stats: repSeed.stats,
    rawStats: repSeed.rawStats,
    docError: '',
    rendering: false,
    // The statline seeds for the player picker (ReportsTemplates fills them).
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

  $effect(() => subscribeMetricProgress((snap) => (m.metricProgress = snap)));
  // Completion is the refetch point: metric-done replaced the stored rows, so
  // the state map and the picked set reload, and the appendix re-reads.
  $effect(() =>
    onMetricDone(() => {
      m.reload += 1;
      loadMetricsList();
    }),
  );

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

</script>
<div class="builtin-root">

<spectra.Child name="builtin-reports-templates" props={{ m, embedded }} />
<spectra.Child name="builtin-reports-appendix" props={{ m }} />
</div>
