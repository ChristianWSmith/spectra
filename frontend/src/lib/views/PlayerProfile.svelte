<script>
  // Cross-match player profile (PRD §5.13): header stats,
  // hand-rolled SVG sparklines (no chart lib), splits and
  // match history. Inline player picker (listPlayers) lives at the top.
  import { getProfile, listPlayers, getCareerTrend, errText } from '../services.js';
  import {
    ADR_SIGMA_DEF,
    OPENING_DEF,
    PROFILE_TRADE_DEF,
    AVG_FLASHED_DEF,
    AVG_UTIL_DEF,
    KAST_DEF,
  } from '../definitions.js';
  import { fmt1, fmt2, fmtPercent, fmtDate, fmtInt } from '../fmt.js';
  import { buildHash } from '../router.js';
  import Popover from '../components/Popover.svelte';
  import StatCard from '../components/StatCard.svelte';
  import { profileBackTarget } from '../nav.js';

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

  // Player picker (listPlayers).
  let q = $state('');
  let results = $state([]);
  let searchTok = 0;
  let pickerEl = $state(null);

  // Escape / click-outside dismissal. Bumping searchTok drops an in-flight
  // search so it cannot reopen the list we just closed.
  function dismissResults() {
    searchTok++;
    results = [];
  }

  $effect(() => {
    const sid = steamId;
    profile = null;
    profileError = '';
    if (!sid) return;
    let live = true;
    getProfile(sid)
      .then((p) => {
        if (live) {
          profile = p;
          profileError = p ? '' : 'Profile not found.';
        }
      })
      .catch((e) => {
        if (live) profileError = errText(e);
      });
    return () => (live = false);
  });

  $effect(() => {
    const sid = steamId;
    const m = metric;
    trend = [];
    trendError = '';
    if (!sid) return;
    let live = true;
    getCareerTrend(sid, m)
      .then((rows) => {
        if (live) trend = rows || [];
      })
      .catch((e) => {
        if (live) trendError = errText(e);
      });
    return () => (live = false);
  });

  $effect(() => {
    const query = q;
    const tok = ++searchTok;
    if (!query.trim()) {
      results = [];
      return;
    }
    const t = setTimeout(() => {
      listPlayers(query)
        .then((rows) => {
          if (tok === searchTok) results = rows || [];
        })
        .catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  });

  function pick(steam) {
    q = '';
    results = [];
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

  // ProfileTrendPoint has no date — join matchId → extractedAt via history.
  const dateByMatch = $derived.by(() => {
    const map = new Map();
    for (const h of profile?.history || []) map.set(h.matchId, h.extractedAt);
    return map;
  });

  // Hand-rolled sparkline: x = Seq (oldest → newest), y = Value.
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
        title: `${fmtDate(dateByMatch.get(p.matchId) || '')} · ${fmtProfileMetric(p.value, metric)}`,
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
    <div class="prof-picker" bind:this={pickerEl}>
      <label class="sr-only" for="prof-q">Find players</label>
      <input
        class="input"
        id="prof-q"
        type="search"
        placeholder="Find players…"
        bind:value={q}
      />
      <Popover open={results.length > 0} anchor={pickerEl} onClose={dismissResults}>
        <div class="prof-results" role="listbox" aria-label="Player results">
          {#each results as r (r.steamId)}
            <button class="prof-result" onclick={() => pick(r.steamId)}>
              <strong>{r.name}</strong>
              <span class="muted">{r.matches} match{r.matches === 1 ? '' : 'es'}</span>
              <span class="spacer"></span>
              <span class="num muted">ADR {fmt1(r.adrAvg)}</span>
            </button>
          {/each}
        </div>
      </Popover>
    </div>
  </header>

  {#if profileError}
    <p class="error" role="alert">{profileError}</p>
  {/if}

  {#if profile}
    <div class="stat-grid">
      <StatCard label="Matches" value={profile.matches} sub={`${profile.wins} wins`} title="Matches in the library for this player" />
      <StatCard label="Win%" value={fmtPercent(profile.winPct)} sub={`${profile.wins}/${profile.matches || 0}`} title="Share of matches won" />
      <StatCard label="ADR ± σ" value={`${fmt1(profile.adrAvg)} ± ${fmt1(profile.adrStd)}`} sub="consistency" title={ADR_SIGMA_DEF} />
      <StatCard label="K/D" value={fmt2(profile.kd)} sub="career" title="Kills ÷ deaths across all matches" />
      <StatCard label="HS%" value={fmtPercent(profile.hsPct)} sub="headshots" title="Headshot share of kills" />
      <StatCard label="KAST%" value={fmtPercent(profile.kastPct)} sub="kill/assist/trade/survive" title={KAST_DEF} />
      <StatCard label="Opening duels" value={fmtPercent(profile.openingRate)} sub="win rate" title={OPENING_DEF} />
      <StatCard
        label="Trade rate"
        value={fmtPercent(profile.tradeRate)}
        sub={profile.tradeOpps > 0 ? `${profile.trades} of ${profile.tradeOpps} opportunities` : 'trades ÷ opportunities'}
        title={PROFILE_TRADE_DEF}
      />
      <StatCard
        label="Clutches"
        value={profile.clutches}
        sub={`${fmtPercent(profile.clutchWinPct)} won`}
        title="Detected clutches (1vN) and the share won (clutch v2)"
      />
      <StatCard
        label="Avg enemies flashed"
        value={fmt1(profile.avgEnemiesFlashed)}
        sub="per match"
        title={AVG_FLASHED_DEF}
      />
      <StatCard
        label="Avg util damage"
        value={fmt1(profile.avgUtilDamage)}
        sub="per match"
        title={AVG_UTIL_DEF}
      />
    </div>

    <section class="panel">
      <div class="row-between">
        <h2>Trend</h2>
        <div class="prof-metrics" role="group" aria-label="Trend metric">
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
        <p class="error" role="alert">{trendError}</p>
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
          · x = sequence (oldest → newest) · click a dot to open the match
        </p>
      {:else if trend.length === 1}
        <p class="muted" role="status">Only one data point — a trend needs at least two matches.</p>
      {:else}
        <p class="muted" role="status">No trend data for this metric yet.</p>
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
              <tr><td colspan="6" class="muted">No side splits.</td></tr>
            {/each}
          </tbody>
        </table>
      </section>

      <section class="panel">
        <h2>Maps <span class="muted">(click a row to open it in the Library)</span></h2>
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
              <tr><td colspan="4" class="muted">No map splits.</td></tr>
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
              <th scope="col">Date</th>
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
                  <span class="chip side {h.startSide}" title="Side the player started the match on">
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
    <p class="muted" role="status">Loading…</p>
  {/if}
</div>
