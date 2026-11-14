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
  import { OPENING_DEF } from '../definitions.js';
  import { fmt1, fmt2, fmtPercent, fmtDate, fmtInt, fmtPatch, fmtMetric } from '../fmt.js';
  import { buildHash } from '../router.js';
  import { readOrder, resolvePinIds, pinnedInSequence } from '../metricorder.js';
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

  const METRICS = [
    { key: 'adr', label: 'ADR' },
    { key: 'kast', label: 'KAST%' },
    { key: 'kd', label: 'K/D' },
    { key: 'hs', label: 'HS%' },
  ];

  let profile = $state(null);
  let profileError = $state('');
  let metric = $state('adr');
  let trend = $state([]);
  let trendError = $state('');

  // Player picker: every player in the library (listPlayers('') — the
  // same source the Profiles view and the Library's player facet use),
  // fetched once and filtered client-side by SuggestInput, which owns the
  // dropdown, the keyboard and the dismissal. Picking navigates to the
  // canonical /player/:steamid view.
  // The finder's query is view-local state: it restores across
  // navigation through the process-scoped registry (viewstate.svelte.js
  // — flat key; the same search pool for every profile). The route's
  // own query above stays URL-owned and is never registered.
  const finderSeed = seed('player', { q: '' });
  let q = $state(finderSeed.q);
  $effect(() => remember('player', { q }));
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

  // --- Career metrics (stored-metrics design §1a/§5) -----------------------
  // Profile-scope pins live under their OWN localStorage key —
  // 'spectra:pinned-profile-metrics' — written scope-routed by Builder's
  // single pin button (design §3: one mechanism, scope-routed); the
  // scoreboard key never carries them and vice versa. Ids resolve through
  // listMetrics (scope='profile' only) and read the CAREER grain through
  // the canonical read (match_id = 0 rows; the bucket read also carries
  // the unit coverage the state machine needs). Rendered per the design's
  // state machine: fresh → the value, no-data → '—', anything else → the
  // state chip — never a fabricated 0, never a version number.
  const PROFILE_PINS_KEY = 'spectra:pinned-profile-metrics';
  let careerPins = $state([]);
  let careerCols = $state([]);
  let careerError = $state('');
  let metricStates = $state(new Map());
  let metricProgress = $state(new Map());
  // Refetch trigger: spectra:metric-done replaced the stored rows (the
  // read cache already flushed through services' listener).
  let careerReload = $state(0);

  function readProfilePins() {
    // The RAW stored selection — null when the key is ABSENT (the
    // absent-vs-present rule lives in metricorder.resolvePinIds:
    // absent ⇒ DEFAULT_PINS through the catalog, present ⇒ verbatim).
    try {
      const raw = localStorage.getItem(PROFILE_PINS_KEY);
      if (raw == null) return null;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return null;
      return [...new Set(arr.map(Number).filter((n) => Number.isFinite(n)))];
    } catch {
      return null;
    }
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
    if (stored && stored.length === 0) return; // present-empty: nothing pinned
    Promise.all([listMetrics(), readOrder('profile')])
      .then(([defs, order]) => {
        if (!live) return;
        const rows = defs || [];
        // Absent key ⇒ DEFAULT_PINS resolved by name through the catalog
        // (design §1.6); present ⇒ the stored selection verbatim.
        const pinIds = resolvePinIds('profile', stored, rows);
        careerPins = pinIds;
        if (pinIds.length === 0) return;
        // THE composition (lib/metricorder.js — the ONE site): the
        // profile sequence filtered to the pinned set — the pins array
        // orders nothing.
        const picked = pinnedInSequence('profile', order, rows, pinIds);
        if (picked.length === 0) return;
        const ids = picked.map((d) => d.id);
        // ONE stored read for every profile pin (the whole career bucket
        // — rows for other players are this unit's coverage, never
        // displayed here) beside the one compute-state read.
        return Promise.all([getMetricValuesForPlayer('', ids), getMetricComputeState()]).then(
          ([values, states]) => {
            const byMetric = new Map();
            for (const v of values || []) {
              if (!byMetric.has(v.metricId)) byMetric.set(v.metricId, []);
              byMetric.get(v.metricId).push(v);
            }
            const stateById = new Map((states || []).map((s) => [s.metricId, s]));
            if (live) metricStates = stateById;
            return picked.map((def) => {
              const unit = byMetric.get(def.id) || [];
              return {
                def,
                row: unit.find((v) => v.steamId === sid) || null,
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

  function fmtProfileMetric(v, m) {
    if (!Number.isFinite(v)) return '—';
    if (m === 'kast' || m === 'hs') return fmtPercent(v);
    if (m === 'kd') return fmt2(v);
    return fmt1(v);
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
        title: `${fmtPatch(p.patch)} · Imported ${fmtDate(p.extractedAt)} · ${fmtProfileMetric(p.value, metric)}`,
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
      <h1>Player</h1>
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
      <button class="btn small" onclick={loadProfile}>Retry</button>
    </p>
  {/if}

  {#if profile}
    <!-- The FIXED block of the profile surface (dogfooding design §1.5):
         the Go-rendered stats in their current relative order, minus the
         nine cards that converted to metrics. The "Career metrics"
         panel below is the metric half of the same surface — with W1's
         default pins it re-expresses today's eleven cards as these 4
         fixed cards followed by 9 metric rows. -->
    <div class="stat-grid">
      <StatCard label="Matches" value={profile.matches} sub={`${profile.wins} wins`} title="Matches in the library for this player" />
      <StatCard label="Win%" value={fmtPercent(profile.winPct)} sub={`${profile.wins}/${profile.matches || 0}`} title="Share of matches won" />
      <StatCard label="Opening duels" value={fmtPercent(profile.openingRate)} sub="win rate" title={OPENING_DEF} />
      <StatCard
        label="Clutches"
        value={profile.clutches}
        sub="1vN"
        title="Clutches (1vN) found in this player's matches"
      />
    </div>

    <!-- Career metrics — the METRIC half of the profile surface
         (dogfooding design §3.5): profile-scope pins read from the
         stored career rows (one canonical read for the whole pinned
         set, the state machine per cell). With W1's default pins this
         renders the nine converted metrics in default order directly
         after the four fixed cards above — today's eleven cards,
         re-expressed. Hidden entirely while nothing is pinned that
         resolves; a failed read shows its own alert. -->
    {#if careerCols.length > 0 || careerError}
      <section class="panel">
        <h2>Career metrics</h2>
        {#if careerError}
          <p class="error" role="alert">
            Career metrics unavailable: {careerError}
            <button class="btn small" onclick={() => (careerReload += 1)}>Retry</button>
          </p>
        {/if}
        {#if careerCols.length > 0}
          <div class="table-scroll">
            <table class="data-table">
              <thead>
                <tr>
                  <th scope="col">Metric</th>
                  <th scope="col" class="num">Value</th>
                </tr>
              </thead>
              <tbody>
                {#each careerCols as col (col.def.id)}
                  {@const pres = careerPres(col)}
                  <tr>
                    <td title={col.def.doc || col.def.name}
                      >{col.def.title || col.def.name}</td
                    >
                    <td class="num" title={careerTitle(col, pres)}>
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
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </section>
    {/if}

    <section class="panel">
      <div class="row-between">
        <h2>Trend</h2>
        <div class="prof-metrics" role="group" aria-label="Trend stat">
          {#each METRICS as m (m.key)}
            <button
              class="btn small prof-metric"
              class:active={metric === m.key}
              onclick={() => (metric = m.key)}
            >{m.label}</button>
          {/each}
        </div>
      </div>
      {#if trendError}
        <p class="error" role="alert">
          {trendError}
          <button class="btn small" onclick={loadTrend}>Retry</button>
        </p>
      {:else if spark}
        <svg
          class="prof-spark"
          viewBox="0 0 {spark.W} {spark.H}"
          role="img"
          aria-label="{metric} trend across {trend.length} matches"
        >
          <polyline points={spark.line} fill="none" stroke="var(--accent)" stroke-width="2" />
          {#each spark.dots as d, i (i)}
            <circle
              cx={d.x}
              cy={d.y}
              r="3.5"
              role="button"
              tabindex="0"
              aria-label="Open match — {d.title}"
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
          {trend.length} matches · min {fmtProfileMetric(spark.min, metric)} · max {fmtProfileMetric(spark.max, metric)}
          · x = sequence (patch order → import order within a patch) · click a dot to open the match
        </p>
      {:else if trend.length === 1}
        <p class="muted" role="status">Only one match so far — the trend line needs at least two.</p>
      {:else}
        <p class="muted" role="status">No trend data for this stat yet.</p>
      {/if}
    </section>

    <div class="prof-splits">
      <section class="panel prof-sides">
        <h2>Sides</h2>
        <table class="data-table">
          <thead>
            <tr>
              <th scope="col">Side</th>
              <th scope="col" class="num">Rounds</th>
              <th scope="col" class="num">Win%</th>
              <th scope="col" class="num">ADR</th>
              <th scope="col" class="num">KAST</th>
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
              <tr><td colspan="6" class="muted">No CT/T breakdown yet.</td></tr>
            {/each}
          </tbody>
        </table>
      </section>

      <section class="panel">
        <h2>Maps</h2>
        <table class="data-table">
          <thead>
            <tr>
              <th scope="col">Map</th>
              <th scope="col" class="num">Matches</th>
              <th scope="col" class="num">Wins</th>
              <th scope="col" class="num">ADR</th>
            </tr>
          </thead>
          <tbody>
            {#each maps as m (m.map)}
              <tr
                class="clickable"
                tabindex="0"
                title="Open {m.map || '—'} matches for this player in the Library"
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
              <tr><td colspan="4" class="muted">No per-map breakdown yet.</td></tr>
            {/each}
          </tbody>
        </table>
      </section>

      <section class="panel">
        <h2>Weapons <span class="muted">(top {weapons.length})</span></h2>
        <table class="data-table">
          <thead>
            <tr>
              <th scope="col">Weapon</th>
              <th scope="col" class="num">Kills</th>
              <th scope="col" class="num">Damage</th>
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
              <tr><td colspan="4" class="muted">No weapon rows.</td></tr>
            {/each}
          </tbody>
        </table>
      </section>
    </div>

    <section class="panel">
      <h2>Match history <span class="muted">(most recent first)</span></h2>
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th
                scope="col"
                title="Import date of the demo — CS2 demos record no played time"
              >Imported</th>
              <th scope="col">Map</th>
              <th scope="col">Result</th>
              <th scope="col" class="num">Score</th>
              <th scope="col">Starting side</th>
              <th scope="col" class="num">K/D/A</th>
              <th scope="col" class="num">ADR</th>
              <th scope="col" class="num">KAST%</th>
            </tr>
          </thead>
          <tbody>
            {#each history as h, i (i)}
              <tr
                class="clickable"
                tabindex="0"
                title="Open match {h.matchId}"
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
                    title="Side the player started the match on"
                  >
                    {(h.startSide || '—').toUpperCase()}
                  </span>
                </td>
                <td class="num">{h.kills}/{h.deaths}/{h.assists}</td>
                <td class="num">{fmt1(h.adr)}</td>
                <td class="num">{fmtPercent(h.kastPct)}</td>
              </tr>
            {:else}
              <tr><td colspan="8" class="muted">No matches yet.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  {:else if !profileError}
    <p class="muted" role="status"><StatusChip block detail="Loading…" /></p>
  {/if}
</div>
