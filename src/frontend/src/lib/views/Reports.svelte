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
  import { readOrder, inSequence, composedSequence, rawItems, isRawId } from '../metricorder.js';
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
    // The appendix SELECTION, split by KIND (N5): `stats` holds picked
    // METRIC ids (numbers, as before), `rawStats` holds the raw
    // counterpart ids ('raw:<field>' strings — GetScoreboard's recorded
    // values, which carry no metric definition and therefore can never
    // live in `stats`). No duplicates possible in either set
    // (TokenSelect filters the list against BOTH), rendered in the
    // composed order by the `picked` derivation below. View-local
    // working state like the rest of this view's selection: registry-
    // owned (viewstate), never the URL, never web storage. A fresh key
    // (the retired `rows` picker shape is not migrated — pre-release,
    // wipe-and-rerun is the contract).
    stats: [],
    rawStats: [],
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
  let stats = $state(repSeed.stats); // picked metric ids (a set) — chip order comes from `picked`
  let rawStats = $state(repSeed.rawStats); // picked raw ids ('raw:<field>') — same `picked` order
  $effect(() => remember('reports', { tplId, matchId, steamId, roundNo, stats, rawStats }));
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
  // The picker's statline — every gameplay-stat half its option rows
  // show reads a STORED seed row now (the owner ruling of 2026-11-17:
  // the metrics system IS the gameplay-statistics layer): the five
  // match-scope seeds (kills / deaths / assists / adr / rounds_played)
  // resolve by NAME through the catalog this view already loads and ride
  // the ONE canonical stored read beside sbBySteam
  // (getMetricValuesForMatch, fresh rows only). Shape: seed name →
  // {def, bySteam: steamId → {value, n, format}}. A player with no
  // FRESH row for a seed has no entry there — that half renders the
  // honest dash with the state word in its title, never the scoreboard
  // column behind it, never a fabricated 0. The picker owns the CAREER
  // pair (career_matches / career_adr) through the same batched bucket
  // read it has always used — the two grains never mix inside one row.
  const STATLINE_SEEDS = ['kills', 'deaths', 'assists', 'adr', 'rounds_played'];
  let sbBySteam = $state({});
  let seeds = $state(new Map());

  $effect(() => {
    const id = matchId;
    const scope = tpl && tpl.scope;
    if (!id || scope !== 'player') {
      sbBySteam = {};
      seeds = new Map();
      return;
    }
    let live = true;
    // The catalog lands with loadMetricsList (and reloads on every
    // metric-done — the sweep that replaced these rows), so reading it
    // here both fills the halves once the definitions are known and
    // refetches when a sweep moves the rows.
    const catalog = new Map((metrics || []).filter((d) => d && d.name).map((d) => [d.name, d]));
    const matchDefs = STATLINE_SEEDS.map((n) => catalog.get(n)).filter(
      (d) => d && (d.scope || 'match') === 'match',
    );
    const out = new Map(matchDefs.map((d) => [d.name, { def: d, bySteam: new Map() }]));
    Promise.all([
      getScoreboard(id, '', false),
      matchDefs.length ? getMetricValuesForMatch(id, matchDefs.map((d) => d.id)) : Promise.resolve([]),
    ])
      .then(([rows, values]) => {
        if (!live) return;
        const m = {};
        for (const r of listedPlayers(rows) || []) m[r.steamId] = r;
        sbBySteam = m;
        const nameById = new Map(matchDefs.map((d) => [d.id, d.name]));
        for (const v of values || []) {
          const name = nameById.get(v.metricId);
          const entry = name && out.get(name);
          if (entry) entry.bySteam.set(v.subjectKey, { value: v.value, n: v.n, format: entry.def.format });
        }
        seeds = out;
      })
      .catch(() => {
        if (live) {
          sbBySteam = {};
          seeds = new Map();
        }
      });
    return () => (live = false);
  });

  // The metric catalog on offer is FLAT and match-scope only (design §5:
  // the Reports appendix is a per-match document — profile-scope metrics
  // surface on PlayerProfile, and the groupBy grouping died with the W2
  // grammar wave: every table is "per player"). The TOKEN FIELD's item
  // universe is that catalog PLUS the raw recorded-value items (N5):
  // the fixed stats' GetScoreboard counterparts (metricorder.rawItems —
  // labels from the ONE fixed-label table), composed through the SAME
  // order mechanism (lib/metricorder.js — the one ordering mechanism).
  // A raw item has no metric definition by construction: it is a stored
  // column, not a computed value, which is exactly why it can be added
  // here at all.
  const matchMetrics = $derived(inSequence('match', orderPref, metrics));

  // The raw offer (N5): the fixed stats' recorded-value counterparts —
  // a STATIC list over metricorder.rawItems (labels from the ONE
  // fixed-label table, ids namespaced 'raw:<field>'). Recorded values
  // are not metrics: they carry no definition, no formula and no
  // compute state, which is what makes them addable here at all.
  // Since the unification of 2026-11-18 the list is EXACTLY Score —
  // every other recorded-value stat whose seed exists offers through
  // the metric catalog instead (one entity per stat: a `raw:kills` id
  // beside the `kills` metric was the duplicate the owner retired; a
  // stale raw pick in a saved selection drops by construction, as
  // `raw:kda` did).
  const rawOffer = rawItems('match');

  // appendixItems — THE ordered item universe: the composed sequence's
  // raw entries (their fixed stats' position) interleaved with its
  // metric definitions. It feeds the field, `picked` and the export's
  // section rank, so chips and document sections read in ONE order.
  // Visibility is VIEW-display only (lead ruling): a hidden fixed stat
  // is still addable here — this view never reads the hidden pref.
  const appendixItems = $derived.by(() => {
    const rawByLabel = new Map(rawOffer.map((r) => [r.label, r]));
    const out = [];
    for (const e of composedSequence('match', orderPref, metrics)) {
      if (e.kind === 'fixed') {
        const raw = rawByLabel.get(e.label);
        if (raw) out.push(raw);
      } else {
        out.push(e.def);
      }
    }
    return out;
  });

  // --- The appendix selection (a SET of stat ids, split by kind) ------------
  // `picked` is its RENDER — the item universe filtered to both sets,
  // which is exactly the composed order, so the chips read in the same
  // order the exported document's sections do (and the token field can
  // never re-offer a picked stat: TokenSelect filters its list against
  // the tokens, so no duplicate can form).
  const itemText = (m) => (m.kind === 'raw' ? m.label : m.title || m.name);
  const picked = $derived(
    appendixItems.filter((it) =>
      isRawId(it.id) ? rawStats.includes(it.id) : stats.includes(it.id),
    ),
  );

  // addStat/removeStat write the SETS (idempotent — the list is already
  // filtered, this is the belt to its braces), routed by the id's
  // namespace: a raw pick never enters `stats` (it has no definition id
  // and must never reach a metric-value read) and vice versa.
  function addStat(m) {
    if (isRawId(m.id)) {
      if (!rawStats.includes(m.id)) rawStats = [...rawStats, m.id];
    } else if (!stats.includes(m.id)) {
      stats = [...stats, m.id];
    }
  }

  function removeStat(id) {
    if (isRawId(id)) rawStats = rawStats.filter((x) => x !== id);
    else stats = stats.filter((x) => x !== id);
  }

  // ONE stored read for the whole picked set (design §5: no per-toggle
  // query-time run): re-runs whenever the target, either selection, the
  // definition list or a metric-done completion changes it. Each picked
  // id that still resolves to a definition gets an entry — an id whose
  // metric is gone drops out (deleted metrics never render), and a
  // picked metric with no stored row for this match keeps an honest
  // empty row list (the state decides what renders, never a 0).
  // A raw pick (N5) reads the SCOREBOARD instead — GetScoreboard is a
  // cachedRead, so this is the same shared call the player-target
  // effect makes (one backend read per match), and it NEVER reaches a
  // metric-value read or PreviewMetric: a recorded value has no
  // definition to compute.
  $effect(() => {
    const gen = ++appendixGen;
    const mid = matchId;
    appendixReload; // spectra:metric-done → refetch (the cache flushed)
    const rawSel = rawOffer.filter((r) => rawStats.includes(r.id)); // reactive: a new raw pick re-runs
    const defs = new Map(metrics.map((m) => [m.id, m]));
    const sel = stats.filter((id) => defs.has(id)).sort((a, b) => a - b);
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
          // Subject-aware labels (metrics Phase 7, 2026-11-18 — the
          // match-subject catalog entries are first-class appendix
          // citizens): a player row keeps its roster-name label; a
          // match-subject row's address IS the match (its label says
          // so); a team row keys by its stamped team; an IDENTITY row's
          // valueKey names the winner the argmax recorded — the label
          // renders that name (an unresolvable key is the dash, never a
          // raw id), and the value stays the stored companion. Records
          // show what was recorded: every row is a stored read, never a
          // recompute.
          const subject = (def && def.subject) || 'player';
          const labelFor = (v) => {
            if (v.valueKey) return bySteam.get(v.valueKey) || '—';
            if (subject === 'match') return `match #${matchId}`;
            if (subject === 'team') return v.subjectKey;
            return bySteam.get(v.subjectKey) || v.subjectKey;
          };
          const valRows = (byMetric.get(id) || []).map((v) => ({
            id: v.subjectKey,
            label: labelFor(v),
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
        // Raw rows: one row per ROSTER player (listedPlayers — bots are
        // never listed; the shape is the metric rows' own), the value
        // read straight off the recorded field, and N = that player's
        // stored round count (honest — never a formula's sample size,
        // because this is not a formula).
        for (const r of rawSel) {
          const rawRows = (listedPlayers(board || []) || []).map((p) => ({
            id: p.steamId,
            label: bySteam.get(p.steamId) || p.name || p.steamId,
            value: Number.isFinite(p[r.field]) ? p[r.field] : null,
            n: Number.isFinite(p.roundsPlayed) ? p.roundsPlayed : null,
          }));
          next[r.id] = {
            loading: false,
            rows: rawRows,
            raw: r,
            unitHasRows: rawRows.length > 0,
          };
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

  // THE state machine for one appendix entry (lib/metricstate.js,
  // design §5): the live progress feed wins, then value / '—' / chip.
  // A value-kind entry carries its rows; everything else renders the
  // state word.
  // RAW entries branch BEFORE the machine (N5): a recorded value has no
  // compute state — it can never be processing/failed/behind — so it
  // answers its own honest kind instead of a state the words don't
  // cover (Number() below would also miss the namespaced id).
  function appendixPres(id) {
    const a = appendix[id];
    if (!a || a.loading || a.error) return null;
    if (a.raw) return { kind: 'raw', rows: a.rows || [] };
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
  // copy (failed carries the compute error, never a stamp). A RAW entry
  // earns a static PROVENANCE chip instead (no state, no row count —
  // the recorded value just is what the match recorded).
  function appendixChip(id) {
    const pres = appendixPres(id);
    if (!pres) return null;
    if (pres.kind === 'raw') return { kind: 'recorded' };
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
  // surface renders its stats, so the exported appendix follows the
  // COMPOSED match sequence, not the selection's id-ASC build order).
  // appendixItems IS that sequence (metricorder.composedSequence — the
  // one ordering mechanism: the raw fixed entries sit at their fixed
  // positions, the metric definitions at theirs); an entry whose stat
  // fell out of it (a definition the catalog no longer lists) trails.
  // Object.entries hands STRING keys over, so the rank map is
  // string-keyed — metric ids and 'raw:<field>' ids rank through one
  // lookup, and a string id never falls into Number() (NaN) here.
  function appendixEntries() {
    const rank = new Map(appendixItems.map((it, i) => [String(it.id), i]));
    return Object.entries(appendix)
      .filter(([, a]) => !a.loading && !a.error && a.rows && (a.metric || a.raw))
      .sort(([a], [b]) => {
        const ra = rank.get(String(a));
        const rb = rank.get(String(b));
        if (ra === undefined && rb === undefined) {
          return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
        }
        if (ra === undefined) return 1;
        if (rb === undefined) return -1;
        return ra - rb;
      });
  }

  // The entry's display title: the metric's title||name, else the raw
  // item's label (its ONE fixed-label source — never a second list).
  const entryTitle = (a) => (a.raw ? a.raw.label : a.metric.title || a.metric.name);

  // Does this entry carry a TABLE? The metric's fresh rows and a raw
  // entry's recorded rows both do; a state (or an entry still loading)
  // earns its line alone.
  const entryHasTable = (id) => ['value', 'raw'].includes((appendixPres(id) || {}).kind);

  // The sample-size cell: a real count, else the honest dash — a raw
  // row without a stored round count states nothing rather than a 0.
  const cellN = (r) => (Number.isFinite(r.n) ? r.n : '—');

  // The per-entry meta line: fresh rows → "per subject · N rows" (the
  // design §5 copy with the SUBJECT spelled per metric since Phase 7,
  // 2026-11-18 — a match-subject entry reads "per match", a team one
  // "per team", the player default unchanged); a RAW entry → its
  // parallel recorded-value line (it has no formula, so there is no
  // computed sample size to state — only the players it lists); any
  // other state → the honest "value not computed" line with the state
  // word. No stamp, no timestamp, ever (design §5's export pin).
  function appendixLine(id, a) {
    if (a.raw) return `recorded value · per player · ${a.rows.length} players`;
    const pres = appendixPres(id);
    if (pres && pres.kind === 'value') {
      const subject = (a.metric && a.metric.subject) || 'player';
      const unit = subject === 'match' ? 'per match' : subject === 'team' ? 'per team' : 'per player';
      return `${unit} · ${a.rows.length} rows · match #${matchId}`;
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
      out += `### ${entryTitle(a)}\n\n`;
      out += `${appendixLine(id, a)}\n\n`;
      if (!entryHasTable(id)) continue;
      out += '| Group | Label | Value | n |\n|---|---|---|---|\n';
      for (const r of a.rows) {
        out += `| ${mdCell(r.id)} | ${mdCell(r.label)} | ${fmtVal(r.value)} | ${cellN(r)} |\n`;
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
      out += `<h3>${esc(entryTitle(a))}</h3>`;
      out += `<p>${esc(appendixLine(id, a))}</p>`;
      if (!entryHasTable(id)) continue;
      out += '<table class="data-table mini"><thead><tr><th>Group</th><th>Label</th><th class="num">Value</th><th class="num">n</th></tr></thead><tbody>';
      for (const r of a.rows) {
        out += `<tr><td>${esc(r.id)}</td><td>${esc(r.label)}</td><td class="num">${fmtVal(r.value)}</td><td class="num">${cellN(r)}</td></tr>`;
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
    <!-- The save button is NOT here (W17, owner 2026-11-16): it moved
         down to the stats-appendix line, beside the field whose picks it
         exports — see the .row-between around the TokenSelect below. -->
    <h2>{S.reports.templateAndTarget}</h2>
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
              {seeds}
              states={metricStates}
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

      <!-- Stats appendix (acceptance #1: a picked metric → table under the report). -->
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
      {#if matchMetrics.length === 0 && !metricsError}
        <!-- Gated on metricsError: a failed listMetrics read is UNKNOWN,
             never "no custom stats" — the alert above carries it. This
             is a NOTE, not a gate (N5): the raw recorded values are
             always on offer, so the field itself never disappears. -->
        <p class="muted" role="status">
          {metrics.length
            ? S.reports.noMatchScopedStats
            : S.reports.noCustomStats}
        </p>
      {/if}
      <!-- One field, not N rows: type to search, pick → a chip (the two
           id sets live in `stats`/`rawStats`; TokenSelect renders them
           in the composed sequence — recorded values and metrics
           interleaved by the one ordering mechanism).
           W17 (owner, 2026-11-16): the save button sits at this line's
           RIGHT end, beside the field whose picks it exports — it left
           the panel header. Save icon LEADS the label (it is a save
           now, never a play), and the busy shape stays plain text —
           pinned by progress-presentation.dom.mjs: a save that renders
           the body first is still "Generating…". -->
      <div class="row-between">
        <TokenSelect
          id="rep-stats"
          items={appendixItems}
          text={itemText}
          tokens={picked.map((m) => ({ id: m.id, label: itemText(m) }))}
          placeholder={S.reports.metricHint}
          ariaLabel={S.reports.metricAria}
          removeAria={S.reports.removeStatAria}
          align="start"
          onselect={addStat}
          onremove={removeStat}
        />
        <button class="btn primary" disabled={rendering || !targetReady()} onclick={render}>
          {#if rendering}Generating…{:else}<span class="codicon codicon-save" aria-hidden="true"></span> {S.reports.generateReport}{/if}
        </button>
      </div>
      <!-- The per-picked-stat readout: the honesty line each stat earns
           — expression + row count or STATE chip for a metric (never a
           fabricated number), a static provenance chip for a RECORDED
           value (no formula, no compute state), in the same sequence as
           its chip. -->
      {#each picked as m (m.id)}
        <div class="rep-metric">
          <strong>{itemText(m)}</strong>
          {#if m.kind !== 'raw'}
            <span class="muted mono rep-metric-expr">{m.expr}</span>
          {/if}
          {#if appendix[m.id] && appendix[m.id].loading}
            <span class="muted">…</span>
          {:else if appendix[m.id] && appendix[m.id].error}
            <span class="error-text" title={appendix[m.id].error}>{S.reports.failedLabel}</span>
          {:else if m.kind === 'raw'}
            <!-- A recorded value is not computed: static provenance,
                 never a state chip (it can never be processing, failed
                 or behind) and never a Formula: line (there is no
                 expression — this is a stored column). -->
            <span class="chip">{S.reports.recordedValue}</span>
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
