<script>
  // Cross-match player profile (PRD §5.13): header stats,
  // hand-rolled SVG sparklines (no chart lib), splits and
  // match history. Inline player picker (listPlayers) lives at the top.
  import {
    getProfile,
    listPlayers,
    getCareerTrend,
    listMetrics,
    getMetricValuesForPlayer,
    getMetricSeries,
    getMetricComputeState,
    subscribeMetricProgress,
    onMetricDone,
    errText,
  } from '../services.js';
  import {
    metricPresentation,
    metricStateTitle,
    liveMetricState,
    metricProgressFrac,
    metricProgressStage,
  } from '../metricstate.js';
  import * as S from '../strings/index.js';
  import { fmt1, fmt2, fmtPercent, fmtDate, fmtInt, fmtPatch, fmtMetric } from '../fmt.js';
  import { buildHash } from '../router.js';
  import { readOrder, readHidden, resolvePins, parseStoredPins, pinnedInSequence, inSequence, composedSequence } from '../metricorder.js';
  import StatCard from '../components/StatCard.svelte';
  import SuggestInput from '../components/SuggestInput.svelte';
  import StatusChip from '../components/StatusChip.svelte';
  import { profileBackTarget } from '../nav.js';
  import { listedPlayers } from '../players.js';
  import { teamStartClass } from '../teams.js';
  import { seed, remember } from '../viewstate.svelte.js';

  // query is the route's own (?back= origin for the return trip);
  // origin is the hash the app navigated from — App records it on
  // hashchange. profileBackTarget (lib/nav.js) resolves both.
  let { steamId = null, query = {}, origin = '', nav = () => {} } = $props();

  let profile = $state(null);
  let profileError = $state('');
  let trend = $state([]);
  let trendError = $state('');

  // Player picker: every player in the library (listPlayers('') — the
  // same source the Profiles view and the Library's player facet use),
  // fetched once and filtered client-side by SuggestInput, which owns the
  // dropdown, the keyboard and the dismissal. Picking navigates to the
  // canonical /player/:steamid view.
  // The finder's query AND the trend's picked metric are view-local
  // state: they restore across navigation through the process-scoped
  // registry (viewstate.svelte.js — flat key; the same search pool for
  // every profile, the same trend metric per visit). The route's own
  // query above stays URL-owned and is never registered.
  const finderSeed = seed('player', { q: '', trend: 'adr' });
  let q = $state(finderSeed.q);
  // `metric` IS the metric NAME the series read takes (the trend card
  // picks over the catalog below — no four-name button set anymore).
  let metric = $state(finderSeed.trend || 'adr');
  $effect(() => remember('player', { q, trend: metric }));
  let players = $state([]);

  $effect(() => {
    let live = true;
    listPlayers('')
      .then((rows) => {
        if (live) players = listedPlayers(rows) || [];
      })
      .catch(() => {});
    return () => (live = false);
  });

  // One generation per read — each drops its own stale async result
  // when the steam id (or the trend stat) changes mid-flight, or when a
  // Retry supersedes the previous attempt.
  let profileGen = 0;
  let trendGen = 0;

  // The profile read (mount AND profileError's Retry): the panel goes
  // back to "Loading…" for the flight, so a retry never leaves a blank
  // body or a stale failure on screen.
  function loadProfile() {
    const sid = steamId;
    const my = ++profileGen;
    profile = null;
    profileError = '';
    if (!sid) return;
    getProfile(sid)
      .then((p) => {
        if (my !== profileGen) return;
        profile = p;
        profileError = p ? '' : 'Profile not found.';
      })
      .catch((e) => {
        if (my === profileGen) profileError = errText(e);
      });
  }

  $effect(() => {
    loadProfile();
  });

  // The trend read (mount, stat switch AND trendError's Retry): same
  // contract — the error clears only when the read lands, so the
  // "No trend data" copy never stands in for a failed read.
  function loadTrend() {
    const sid = steamId;
    const m = metric;
    const my = ++trendGen;
    trend = [];
    trendError = '';
    if (!sid) return;
    getCareerTrend(sid, m)
      .then((rows) => {
        if (my !== trendGen) return;
        trend = rows || [];
        trendError = '';
      })
      .catch((e) => {
        if (my === trendGen) trendError = errText(e);
      });
  }

  $effect(() => {
    loadTrend();
  });

  // --- The trend metric picker --------------------------------------------
  // The catalog on offer is the MATCH-scope set in the metricorder
  // sequence (lib/metricorder.js — the ONE ordering mechanism: scope
  // filtered, absent pref ⇒ default sequence). `metric` stays the metric
  // NAME the series read takes; the shared SuggestInput owns the
  // dropdown, the keyboard and the dismissal (the same widget the
  // profile finder above and the Reports appendix rows use).
  let trendDefs = $state([]);
  let orderPref = $state(null);
  let trendText = $state('');

  $effect(() => {
    let live = true;
    Promise.all([listMetrics(), readOrder('match')])
      .then(([defs, order]) => {
        if (!live) return;
        trendDefs = defs || [];
        orderPref = order;
      })
      .catch(() => {
        if (live) trendDefs = []; // a failed catalog read offers nothing — never a guess
      });
    return () => (live = false);
  });

  const trendItems = $derived(inSequence('match', orderPref, trendDefs));

  // A selection the loaded catalog no longer carries falls back to the
  // default — but ONLY from a non-default selection, so a catalog that
  // simply has no match-scope `adr` (or has not loaded yet) never
  // rewrites the selection or re-fires the series read.
  $effect(() => {
    if (trendDefs.length === 0) return;
    if (metric !== 'adr' && !trendItems.some((d) => d.name === metric)) metric = 'adr';
  });

  // The picked metric's DISPLAY name — what the input shows and what the
  // sparkline's aria-label names (never the raw name key). Before the
  // catalog resolves the default still reads as itself.
  const trendLabel = $derived.by(() => {
    const def = trendItems.find((d) => d.name === metric);
    if (def) return def.title || def.name;
    return metric === 'adr' ? 'ADR' : metric;
  });
  $effect(() => (trendText = trendLabel));

  // The picked metric's format tag — the trend formatter's input (the
  // definition is the catalog's, never a per-name special case).
  const trendFormat = $derived(trendItems.find((d) => d.name === metric)?.format || '');

  // --- Career metrics (stored-metrics design §1a/§5) -----------------------
  // Profile-scope pins live under their OWN localStorage key —
  // 'spectra:pinned-profile-metrics' — written scope-routed by Builder's
  // single pin button (design §3: one mechanism, scope-routed); the
  // scoreboard key never carries them and vice versa. Names resolve through
  // listMetrics (scope='profile' only) and read the CAREER grain through
  // the canonical read (match_id = 0 rows; the bucket read also carries
  // the unit coverage the state machine needs). Rendered per the design's
  // state machine: fresh → the value, no-data → '—', anything else → the
  // state chip — never a fabricated 0, never a version number.
  const PROFILE_PINS_KEY = 'spectra:pinned-profile-metrics';
  // The fixed cards' SEED slots (owner ruling, 2026-11-17): a fixed
  // entry whose stat W35 seeded reads its `career_*` row PINS-
  // INDEPENDENTLY — the slot id is unioned into the ONE career read
  // below, exactly like Match's FIXED_SLOTS. Today: @Matches →
  // career_matches (whose seed doc names this very card). The Win% card
  // has no seed (wins are not sum-expressible) and keeps its raw
  // profile fields — see the template branch.
  const CAREER_SLOTS = ['career_matches'];
  let careerPins = $state([]);
  let careerCols = $state([]);
  let careerError = $state('');
  let metricStates = $state(new Map());
  let metricProgress = $state(new Map());
  // Refetch trigger: spectra:metric-done replaced the stored rows (the
  // read cache already flushed through services' listener).
  let careerReload = $state(0);

  function readProfilePins() {
    // The RAW stored selection — null when the key is ABSENT. The parse
    // AND the format drop live in metricorder.parseStoredPins (THE one
    // pins read — drop-never-migrate: an old id-array drops to "no
    // selection" through this SAME path, see its comment); this site
    // only performs the sanctioned localStorage call. The
    // absent-vs-present rule lives in metricorder.resolvePins:
    // absent ⇒ DEFAULT_PINS through the catalog, present ⇒ verbatim).
    return parseStoredPins(localStorage.getItem(PROFILE_PINS_KEY));
  }

  $effect(() => subscribeMetricProgress((snap) => (metricProgress = snap)));
  $effect(() => onMetricDone(() => (careerReload += 1)));

  $effect(() => {
    careerReload; // spectra:metric-done → refetch (the cache flushed)
    const sid = steamId;
    let live = true;
    const stored = readProfilePins(); // null = ABSENT → DEFAULT_PINS below
    careerPins = stored || [];
    careerCols = [];
    careerError = '';
    if (!sid) return;
    // No early return on a present-empty selection: the fixed cards'
    // SEED slots (CAREER_SLOTS) still need their read — only an empty
    // id list (no pins AND no resolvable slot) skips it below.
    Promise.all([listMetrics(), readOrder('profile')])
      .then(([defs, order]) => {
        if (!live) return;
        const rows = defs || [];
        // Absent key ⇒ DEFAULT_PINS resolved by name through the catalog
        // (design §1.6); present ⇒ the stored names verbatim.
        const pinNames = resolvePins('profile', stored, rows);
        careerPins = pinNames;
        // THE composition (lib/metricorder.js — the ONE site): the
        // profile sequence filtered to the pinned set — the pins array
        // orders nothing.
        const picked = pinnedInSequence('profile', order, rows, pinNames);
        const byName = new Map(rows.map((d) => [d.name, d]));
        const slots = CAREER_SLOTS.map((n) => byName.get(n)).filter(Boolean);
        const wanted = [...picked];
        for (const s of slots) {
          if (!wanted.some((d) => d.id === s.id)) wanted.push(s);
        }
        const ids = wanted.map((d) => d.id);
        if (ids.length === 0) return;
        // ONE stored read for every profile pin AND every fixed-card
        // slot (the whole career bucket — rows for other players are
        // this unit's coverage, never displayed here) beside the one
        // compute-state read.
        return Promise.all([getMetricValuesForPlayer('', ids), getMetricComputeState()]).then(
          ([values, states]) => {
            const byMetric = new Map();
            for (const v of values || []) {
              if (!byMetric.has(v.metricId)) byMetric.set(v.metricId, []);
              byMetric.get(v.metricId).push(v);
            }
            const stateById = new Map((states || []).map((s) => [s.metricId, s]));
            if (live) metricStates = stateById;
            return wanted.map((def) => {
              const unit = byMetric.get(def.id) || [];
              return {
                def,
                row: unit.find((v) => v.subjectKey === sid) || null,
                unitHasRows: unit.length > 0,
                error: (stateById.get(def.id) && stateById.get(def.id).error) || '',
              };
            });
          },
        );
      })
      .then((cols) => {
        if (live && cols) careerCols = cols;
      })
      .catch((e) => {
        if (live) careerError = errText(e);
      });
    return () => (live = false);
  });

  // --- The match-history K/D halves (the match-grain SERIES read) -------
  // One history ROW is one match, so the halves come from the series
  // read (services.getMetricSeries — store.GetPlayerMetricSeries) instead
  // of one value read per row: ONE read for the player's whole window,
  // keyed match id → metric id, refetched when the catalog lands and on
  // spectra:metric-done (the sweep replaced the rows the cache flushed).
  // The A half stays the Go fold's stored `assists` row
  // (store.GetPlayerHistory) — Q2's compound-per-half rule composes the
  // three below. A seed the catalog does not carry, or a match with no
  // FRESH row for it, leaves that half a dash: the raw `ps.kills` /
  // `ps.deaths` columns behind the DTO never render here (owner ruling
  // 2026-11-17 — no raw fallback).
  let seriesDefs = $state(new Map()); // seed name → the resolved definition
  let historySeries = $state(new Map()); // matchId → Map(metricId → point)
  let seriesHasRows = $state(new Map()); // metricId → does the series carry ANY point?

  $effect(() => {
    careerReload; // spectra:metric-done → refetch (the cache flushed)
    const sid = steamId;
    const catalog = trendDefs; // the full catalog (listMetrics) — match-scope rows below
    let live = true;
    seriesDefs = new Map();
    historySeries = new Map();
    seriesHasRows = new Map();
    if (!sid) return;
    const defs = (catalog || []).filter(
      (d) => d && ['kills', 'deaths', 'assists'].includes(d.name) && (d.scope || 'match') === 'match',
    );
    if (!defs.length) return; // no seed in the catalog → every half is the honest dash
    const byName = new Map(defs.map((d) => [d.name, d]));
    seriesDefs = byName;
    getMetricSeries(sid, defs.map((d) => d.id))
      .then((points) => {
        if (!live) return;
        const byMatch = new Map();
        const has = new Map(defs.map((d) => [d.id, false]));
        for (const p of points || []) {
          let per = byMatch.get(p.matchId);
          if (!per) {
            per = new Map();
            byMatch.set(p.matchId, per);
          }
          per.set(p.metricId, p);
          if (has.has(p.metricId)) has.set(p.metricId, true);
        }
        historySeries = byMatch;
        seriesHasRows = has;
      })
      .catch(() => {
        /* a failed series read leaves every half a dash — never a raw column */
      });
    return () => (live = false);
  });

  // One history half's presentation (lib/metricstate.js — design §5):
  // the stored series point for THIS match through the state machine,
  // with the metric's own compute state as the state source.
  function historyHalf(name, h) {
    const def = seriesDefs.get(name);
    const per = historySeries.get(h.matchId);
    const row = per && def ? per.get(def.id) || null : null;
    const st = def && metricStates.get(def.id) ? metricStates.get(def.id).state : '';
    return metricPresentation(st, row, !!(def && seriesHasRows.get(def.id)));
  }

  // The A half: the Go fold's stored `assists` value (nil = the fold
  // found no fresh row), with the compute state in front of it exactly
  // like the machine's precedence — a live/behind/failed word never
  // hides behind a number the fold did not produce.
  function historyAssistHalf(h) {
    const def = seriesDefs.get('assists');
    const st = def && metricStates.get(def.id) ? metricStates.get(def.id).state : '';
    if (st === 'processing' || st === 'failed' || st === 'behind') return { kind: 'chip', state: st };
    return h.assists != null ? { kind: 'value', value: h.assists, n: 0 } : { kind: 'nodata' };
  }

  // One half's rendered number: the fresh value through the seed's own
  // format tag, the honest dash otherwise — never the raw column.
  function historyHalfText(name, h) {
    const pres = historyHalf(name, h);
    if (pres.kind !== 'value') return '—';
    const def = seriesDefs.get(name);
    return fmtMetric(pres.value, def ? def.format : '');
  }

  function historyAssistText(h) {
    const pres = historyAssistHalf(h);
    return pres.kind === 'value' ? fmtMetric(pres.value, '') : '—';
  }

  // The compound cell's tooltip, in the roster triple's shape
  // (Match.svelte compoundTitle): EMPTY while every half shows its
  // number — the cell carried no tooltip before the conversion, so the
  // rendered output stays byte-identical — otherwise the first
  // non-value half's state word (invariant 9: the state lives in the
  // title, never a chip inside a compound cell).
  function historyKdaTitle(h) {
    const halves = [
      { name: 'kills', pres: historyHalf('kills', h) },
      { name: 'deaths', pres: historyHalf('deaths', h) },
      { name: 'assists', pres: historyAssistHalf(h) },
    ];
    for (const x of halves) {
      if (x.pres.kind === 'value') continue;
      if (x.pres.kind === 'nodata') return 'no data for this player';
      const def = seriesDefs.get(x.name);
      return metricStateTitle(
        x.pres.state,
        (def && metricStates.get(def.id) && metricStates.get(def.id).error) || '',
      );
    }
    return '';
  }

  // The profile surface's SEQUENCE + VISIBILITY reads (N4): the order
  // pref and the hidden fixed-entry set, read once per mount beside the
  // career values read above (presentation only — a failed pref read
  // falls back to the default order / nothing hidden, never into the
  // career error slot).
  let profOrder = $state(null);
  let profHidden = $state([]);
  $effect(() => {
    let live = true;
    Promise.all([readOrder('profile'), readHidden('profile').catch(() => [])])
      .then(([order, hidden]) => {
        if (live) {
          profOrder = order;
          profHidden = hidden;
        }
      })
      .catch(() => {
        /* the default order stands */
      });
    return () => (live = false);
  });

  // careerCards — THE one composed card list (N4): the fixed pair and
  // the pinned metric tiles as entries of the ONE sequence
  // (metricorder.composedSequence), in order, with a hidden fixed entry
  // dropped (it stays listed in the ordering dialog — visibility is
  // view-display only). An unpinned metric never enters; a pinned one
  // enters only once its stored read landed (the honest gap: the tile
  // appears with its value read, never with a guessed one).
  const careerCards = $derived.by(() => {
    const byName = new Map(careerCols.map((c) => [c.def.name, c]));
    const pinned = new Set(careerPins);
    const out = [];
    for (const e of composedSequence('profile', profOrder, trendDefs, profHidden)) {
      if (e.hidden) continue;
      if (e.kind === 'fixed') {
        out.push({ key: e.key, fixed: e.key, label: e.label, col: null });
      } else if (pinned.has(e.def.name)) {
        const col = byName.get(e.name);
        if (col) out.push({ key: `m:${e.def.id}`, fixed: '', label: e.label, col });
      }
    }
    return out;
  });

  // THE state machine for one career cell (lib/metricstate.js, design §5).
  function careerPres(col) {
    const st = liveMetricState(metricProgress, metricStates, col.def.id);
    return metricPresentation(st, col.row, col.unitHasRows);
  }

  function careerTitle(col, pres) {
    if (pres.kind === 'value') return `${col.def.title || col.def.name} — sample size n=${pres.n}`;
    if (pres.kind === 'nodata') return 'no data for this player';
    return metricStateTitle(pres.state, col.error);
  }

  // The fixed cards' seed slot (CAREER_SLOTS above): the col the ONE
  // career read produced for that name, or null while the read is in
  // flight / the catalog lacks the name — the card then renders the
  // honest dash (never the raw profile field behind it, owner ruling
  // 2026-11-17: no raw fallback).
  function careerSlot(name) {
    return careerCols.find((c) => c.def.name === name) || null;
  }

  // THE state machine for one fixed-card slot (lib/metricstate.js) —
  // the career tile twin over a slot col.
  function careerSlotPres(col) {
    if (!col) return metricPresentation('', null, false);
    const st = liveMetricState(metricProgress, metricStates, col.def.id);
    return metricPresentation(st, col.row, col.unitHasRows);
  }

  function pick(steam) {
    q = '';
    nav(`/player/${steam}`);
  }

  // Maps card → the Library filtered to this player's matches on that map.
  // The route query is the contract with the Library's receiving side:
  // #/library?map=<MapName>&player=<17-digit SteamID64>.
  function openMapInLibrary(map) {
    if (!map || !profile?.steamId) return;
    nav(buildHash('/library', { map, player: profile.steamId }));
  }

  // The trend serves values at DISPLAY scale already — the series read
  // returns a percent-format metric 0..100 (see store.GetTrend) — so
  // percent is the ONE divergence from the shared fmtMetric (which
  // multiplies a stored 0..1 fraction by 100); every other format tag
  // delegates to it, so the trend formats exactly like every other
  // metric cell in the app. Never fmtMetric straight on a percent.
  function fmtTrendValue(v, format) {
    if (format === 'percent') return Number.isFinite(v) ? fmtPercent(v) : '—';
    return fmtMetric(v, format);
  }

  // Hand-rolled sparkline: x = Seq (GetTrend's row order — CS2 patch
  // order, import order within a patch), y = Value. Each dot's tooltip
  // is self-contained: the patch (fmtPatch — the authoritative "when",
  // a demo carries no played-at date) plus the HONEST import label
  // (every date in this app is import time, never implied play time),
  // both read off the trend point itself — no history join, so a dot
  // older than the history table's 100-match window still dates right
  // instead of "Imported —".
  const spark = $derived.by(() => {
    const pts = trend;
    if (pts.length < 2) return null;
    const W = 640;
    const H = 130;
    const P = 10;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      if (p.seq < minX) minX = p.seq;
      if (p.seq > maxX) maxX = p.seq;
      if (p.value < minY) minY = p.value;
      if (p.value > maxY) maxY = p.value;
    }
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    const X = (x) => P + ((x - minX) / spanX) * (W - 2 * P);
    const Y = (y) => H - P - ((y - minY) / spanY) * (H - 2 * P);
    return {
      W,
      H,
      min: minY,
      max: maxY,
      line: pts.map((p) => `${X(p.seq).toFixed(1)},${Y(p.value).toFixed(1)}`).join(' '),
      dots: pts.map((p) => ({
        x: X(p.seq),
        y: Y(p.value),
        value: p.value,
        matchId: p.matchId,
        title: `${fmtPatch(p.patch)} · Imported ${fmtDate(p.extractedAt)} · ${fmtTrendValue(p.value, trendFormat)}`,
      })),
    };
  });

  const sides = $derived(profile?.sides || []);
  const maps = $derived(profile?.maps || []);
  const weapons = $derived((profile?.weapons || []).slice(0, 8));
  const history = $derived(profile?.history || []);

  // Return trip: where the button points, and how to name it (the default
  // target is the Profiles list, so the label names it; anything else is
  // simply "Back").
  const backHash = $derived(profileBackTarget(query, origin));
  const backLabel = $derived(backHash === '/profiles' ? 'Profiles' : 'Back');
</script>

<div class="view">
  <header class="view-header prof-head">
    <button class="btn" onclick={() => nav(backHash)}>
      <span class="codicon codicon-arrow-left"></span>
      {backLabel}
    </button>
    {#if profile}
      <h1 class="prof-name">{profile.name || '—'}</h1>
      <span class="mono muted">{profile.steamId}</span>
    {:else}
      <h1>{S.profiles.h1Player}</h1>
    {/if}
    <div class="spacer"></div>
    <label class="sr-only" for="prof-q">Search players</label>
    <SuggestInput
      id="prof-q"
      wrapClass="prof-picker"
      ariaLabel="Search players"
      items={players}
      kind="player"
      align="end"
      bind:value={q}
      onselect={(p) => pick(p.steamId)}
    />
  </header>

  {#if profileError}
    <p class="error" role="alert">
      {profileError}
      <button class="btn small" onclick={loadProfile}>{S.profiles.retry}</button>
    </p>
  {/if}

  {#if profile}
    <!-- The profile's headline surface (dogfooding design §1.5 + the
         career-metrics consolidation, N4): ONE panel-less block over
         THE composed sequence — the fixed cards (Matches, Win%) and the
         pinned profile-scope metrics as StatCard tiles in metricorder
         order (lib/metricorder.js composedSequence is the ONE ordering
         mechanism). The REAL empty-state invariant: the block renders
         whenever at least ONE entry is visible — a hidden fixed pair
         with nothing pinned renders NO grid (never a broken empty one),
         and a hidden entry simply leaves while the rest keep their
         order. The career half is the same stored-read state machine as
         before (fresh → the value, no-data → '—', anything else → the
         state chip — never a fabricated 0, never a version number); a
         failed career read shows its alert ABOVE the block (the
         profileError pattern). -->
    {#if careerError}
      <p class="error" role="alert">
        {S.profiles.careerErrorLead}{careerError}
        <button class="btn small" onclick={() => (careerReload += 1)}>{S.profiles.retry}</button>
      </p>
    {/if}
    {#if careerCards.length > 0}
      <div class="stat-grid prof-stats">
        {#each careerCards as card (card.key)}
          {#if card.col}
            {@const col = card.col}
            {@const pres = careerPres(col)}
            <!-- One tile per pinned metric through the canonical StatCard:
                 children[0] the label (its `labelTitle` carries the metric's
                 doc), children[1] the value slot running the state machine —
                 the cell's own `title` carries n=/state — never a fabricated
                 0 and never a version number. -->
            <StatCard
              label={col.def.title || col.def.name}
              labelTitle={col.def.doc || col.def.name}
              title={careerTitle(col, pres)}
            >
              {#snippet valueSlot()}
                {#if pres.kind === 'value'}
                  {fmtMetric(pres.value, col.def.format)}
                {:else if pres.kind === 'nodata'}
                  —
                {:else}
                  <StatusChip
                    status={pres.state}
                    title={careerTitle(col, pres)}
                    progress={metricProgressFrac(metricProgress, col.def.id)}
                    stage={metricProgressStage(metricProgress, col.def.id)}
                  />
                {/if}
              {/snippet}
            </StatCard>
          {:else if card.fixed === '@Matches'}
            <!-- W13b: the fixed card's title comes from the ONE label
                 table through composedSequence (card.label = the entry's
                 full name), never a second strings copy of it. The VALUE
                 reads the `career_matches` SEED row through the same
                 state machine as the metric tiles (owner ruling
                 2026-11-17): fresh → the stored count, otherwise the
                 honest dash/state chip — never profile.matches behind
                 it (no raw fallback); the label keeps the seed's doc as
                 its tooltip, the cell its n=/state title. The sub line
                 stays the raw wins count (wins have no seed). -->
            {@const mcol = careerSlot('career_matches')}
            {@const mpres = careerSlotPres(mcol)}
            <StatCard
              label={card.label}
              labelTitle={mcol ? mcol.def.doc || mcol.def.name : undefined}
              sub={`${profile.wins} wins`}
              title={mcol ? careerTitle(mcol, mpres) : S.profiles.statMatchesTitle}
            >
              {#snippet valueSlot()}
                {#if mpres.kind === 'value'}
                  {fmtMetric(mpres.value, mcol.def.format)}
                {:else if mpres.kind === 'nodata'}
                  —
                {:else}
                  <StatusChip
                    status={mpres.state}
                    title={careerTitle(mcol, mpres)}
                    progress={metricProgressFrac(metricProgress, mcol.def.id)}
                    stage={metricProgressStage(metricProgress, mcol.def.id)}
                  />
                {/if}
              {/snippet}
            </StatCard>
          {:else}
            <StatCard label={card.label} value={fmtPercent(profile.winPct)} sub={`${profile.wins}/${profile.matches || 0}`} title={S.profiles.statWinPctTitle} />
          {/if}
        {/each}
      </div>
    {/if}

    <section class="panel">
      <div class="row-between">
        <h2>{S.profiles.trendHeading}</h2>
        <!-- The trend's metric picker: ANY match-scope metric the
             catalog carries (the four-button set is gone — the series
             read takes the metric NAME), offered through the one
             suggestion dropdown in the metricorder sequence. -->
        <SuggestInput
          id="prof-trend"
          wrapClass="prof-trend-pick"
          kind="text"
          items={trendItems}
          text={(d) => d.title || d.name}
          placeholder={S.profiles.trendMetricSearch}
          ariaLabel={S.profiles.trendMetricAria}
          align="end"
          bind:value={trendText}
          onselect={(d) => {
            metric = d.name;
            trendText = d.title || d.name;
          }}
        />
      </div>
      {#if trendError}
        <p class="error" role="alert">
          {trendError}
          <button class="btn small" onclick={loadTrend}>{S.profiles.retry}</button>
        </p>
      {:else if spark}
        <svg
          class="prof-spark"
          viewBox="0 0 {spark.W} {spark.H}"
          role="img"
          aria-label="{trendLabel}{S.profiles.trendAriaLead}{trend.length}{S.profiles.trendAriaTail}"
        >
          <polyline points={spark.line} fill="none" stroke="var(--accent)" stroke-width="2" />
          {#each spark.dots as d, i (i)}
            <circle
              cx={d.x}
              cy={d.y}
              r="3.5"
              role="button"
              tabindex="0"
              aria-label={S.fill(S.profiles.openMatchDot, { title: d.title })}
              onclick={() => d.matchId && nav(`/match/${d.matchId}`)}
              onkeydown={(e) =>
                (e.key === 'Enter' || e.key === ' ') &&
                (e.preventDefault(), d.matchId && nav(`/match/${d.matchId}`))}
            >
              <title>{d.title}</title>
            </circle>
          {/each}
        </svg>
        <p class="muted prof-spark-cap">
          {trend.length}{S.profiles.sparkMinLead}{fmtTrendValue(spark.min, trendFormat)}{S.profiles.sparkMaxLead}{fmtTrendValue(spark.max, trendFormat)}
          {S.profiles.sparkFootnote}
        </p>
      {:else if trend.length === 1}
        <p class="muted" role="status">{S.profiles.onlyOneMatch}</p>
      {:else}
        <p class="muted" role="status">{S.profiles.noTrendData}</p>
      {/if}
    </section>

    <div class="prof-splits">
      <section class="panel prof-sides">
        <h2>{S.profiles.sidesHeading}</h2>
        <table class="data-table">
          <thead>
            <tr>
              <th scope="col">{S.profiles.thSide}</th>
              <th scope="col" class="num">{S.profiles.thRounds}</th>
              <th scope="col" class="num">{S.profiles.thWinPct}</th>
              <th scope="col" class="num">{S.profiles.thAdr}</th>
              <th scope="col" class="num">{S.profiles.thKast}</th>
              <th scope="col" class="num">K/D</th>
            </tr>
          </thead>
          <tbody>
            {#each sides as s (s.side)}
              <tr>
                <td><span class="chip side {s.side}">{(s.side || '—').toUpperCase()}</span></td>
                <td class="num">{s.rounds}</td>
                <td class="num">{fmtPercent(s.roundWinPct)}</td>
                <td class="num">{fmt1(s.adr)}</td>
                <td class="num">{fmtPercent(s.kastPct)}</td>
                <td class="num">{fmt2(s.kd)}</td>
              </tr>
            {:else}
              <tr><td colspan="6" class="muted">{S.profiles.noSides}</td></tr>
            {/each}
          </tbody>
        </table>
      </section>

      <section class="panel">
        <h2>{S.profiles.mapsHeading}</h2>
        <table class="data-table">
          <thead>
            <tr>
              <th scope="col">{S.profiles.thMap}</th>
              <th scope="col" class="num">{S.profiles.thMatches}</th>
              <th scope="col" class="num">{S.profiles.thWins}</th>
              <th scope="col" class="num">{S.profiles.thAdr}</th>
            </tr>
          </thead>
          <tbody>
            {#each maps as m (m.map)}
              <tr
                class="clickable"
                tabindex="0"
                title={S.fill(S.profiles.openMapTitle, { map: m.map || '—' })}
                onclick={() => openMapInLibrary(m.map)}
                onkeydown={(e) =>
                  (e.key === 'Enter' || e.key === ' ') &&
                  (e.preventDefault(), openMapInLibrary(m.map))}
              >
                <td>{m.map || '—'}</td>
                <td class="num">{m.matches}</td>
                <td class="num">{m.wins}</td>
                <td class="num">{fmt1(m.adr)}</td>
              </tr>
            {:else}
              <tr><td colspan="4" class="muted">{S.profiles.noMaps}</td></tr>
            {/each}
          </tbody>
        </table>
      </section>

      <section class="panel">
        <h2>{S.profiles.weaponsPrefix}<span class="muted">{S.profiles.topPrefix}{weapons.length})</span></h2>
        <table class="data-table">
          <thead>
            <tr>
              <th scope="col">{S.profiles.thWeapon}</th>
              <th scope="col" class="num">{S.profiles.thKills}</th>
              <th scope="col" class="num">{S.profiles.thDamage}</th>
              <th scope="col" class="num">HS</th>
            </tr>
          </thead>
          <tbody>
            {#each weapons as w (w.weapon)}
              <tr>
                <td class="mono">{w.weapon}</td>
                <td class="num">{fmtInt(w.kills)}</td>
                <td class="num">{fmtInt(w.damage)}</td>
                <td class="num">{fmtInt(w.headshots)}</td>
              </tr>
            {:else}
              <tr><td colspan="4" class="muted">{S.profiles.noWeapons}</td></tr>
            {/each}
          </tbody>
        </table>
      </section>
    </div>

    <section class="panel">
      <h2>{S.profiles.matchHistoryPrefix}<span class="muted">{S.profiles.mostRecentFirst}</span></h2>
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th
                scope="col"
                title={S.profiles.importedTitle}
              >{S.profiles.thImported}</th>
              <th scope="col">{S.profiles.thMap}</th>
              <th scope="col">{S.profiles.thResult}</th>
              <th scope="col" class="num">{S.profiles.thScore}</th>
              <th scope="col">{S.profiles.thStartingSide}</th>
              <th scope="col" class="num">K/D/A</th>
              <th scope="col" class="num">{S.profiles.thAdr}</th>
              <th scope="col" class="num">{S.profiles.thKastPct}</th>
            </tr>
          </thead>
          <tbody>
            {#each history as h, i (i)}
              <tr
                class="clickable"
                tabindex="0"
                title={S.fill(S.profiles.openMatchRow, { id: h.matchId })}
                onclick={() => nav(`/match/${h.matchId}`)}
                onkeydown={(e) => e.key === 'Enter' && nav(`/match/${h.matchId}`)}
              >
                <td>{fmtDate(h.extractedAt)}</td>
                <td>{h.map || '—'}</td>
                <td>
                  <span class="chip status {h.win ? 'ok' : 'bad'}">
                    {h.win ? 'W' : 'L'}
                  </span>
                </td>
                <td class="num">{h.scoreCT}–{h.scoreT}</td>
                <td>
                  <!-- h.startSide is already the START side (identity, not
                       a live side): teamStartClass with zero switches is
                       the no-flip form — it maps the start side straight
                       to its own identity class ('' → no class, never a
                       guessed color). NEVER `.chip side` here: that
                       paints the side-AT-TIME color on a start-side
                       value. -->
                  <span
                    class="chip {teamStartClass(h.startSide, 0)}"
                    title={S.profiles.startSideTitle}
                  >
                    {(h.startSide || '—').toUpperCase()}
                  </span>
                </td>
                <!-- K/D/A per Q2's per-half rule: ALL THREE halves read
                     their seed now — K and D from the match-grain
                     series read (services.getMetricSeries), the A half
                     from the stored `assists` row the Go fold carries
                     (store.GetPlayerHistory). A half with no fresh row
                     renders the honest dash and the first non-value
                     half's state word reaches the cell through the
                     title — never a fabricated 0, never the raw stored
                     columns behind the DTO. -->
                <td class="num" title={historyKdaTitle(h)}>
                  {historyHalfText('kills', h)}/{historyHalfText('deaths', h)}/{historyAssistText(h)}
                </td>
                <td class="num">{fmt1(h.adr)}</td>
                <td class="num">{fmtPercent(h.kastPct)}</td>
              </tr>
            {:else}
              <tr><td colspan="8" class="muted">{S.profiles.noHistory}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  {:else if !profileError}
    <p class="muted" role="status"><StatusChip block detail={S.profiles.loadingDetail} /></p>
  {/if}
</div>
