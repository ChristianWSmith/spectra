<script>
  // Combat tab: clutches, engagement deep-dive and
  // per-player damage/trade stats. Every inferred metric carries the §6.1
  // badge with its definition in the title attribute.
  import {
    getCombatStats,
    getClutches,
    getEngagements,
    getPlayerRounds,
    getMatch,
    setPendingSeek,
    setPendingTimelineFilter,
  } from '../services.js';
  import { fmtInt, fmtPercent } from '../fmt.js';
  import ClutchCard from '../components/ClutchCard.svelte';

  let { id = 0, nav = () => {} } = $props();

  // Definition texts (keep in sync with Settings → Metric
  // definitions; wording stays generic where the rules are configurable).
  const KAST_DEF =
    'KAST% — share of rounds where the player got a Kill, an Assist, was Traded after death, or Survived (player_round_stats; the trade part follows analysis_config / rule_version).';
  const DMG_CONV_DEF =
    'Damage conversion — damage by this player that contributed to a kill ÷ total damage dealt, derived from stored events (not a raw demo value).';
  const ENTRY_DEF =
    'Entry rate — entry kills ÷ detected entry opportunities, derived from the engagement pass (first kill / site hit).';
  const TRADE_DEF =
    'Trade rate — trades ÷ detected deaths inside the trade window of a teammate kill (window from analysis_config, default 5 s).';
  const UNTRADED_DEF =
    'Untraded deaths — deaths with no teammate kill inside the trade window afterwards (engagement detection).';
  const TRADE_OPP_MISSED_DEF =
    'Trade opportunities missed — INFERRED heuristic (v1): a death where a living teammate was near and alive within the trade window but did not kill the attacker. Not a demo fact.';
  const ENG_KIND_TITLES = {
    opening: 'opening duel — first kill of the round',
    entry: 'entry kill — first kill onto the site by the attacking side',
    trade: 'trade — kill inside the trade window after a teammate died',
    untraded: 'untraded death — neither side answered inside the trade window',
  };

  const STAT_COLS = [
    { key: 'name', label: 'Player', fmt: (r) => r.name },
    { key: 'dmgNoKill', label: 'Dmg no-kill', fmt: (r) => fmtInt(r.dmgNoKill) },
    {
      key: 'dmgConvPct',
      label: 'Dmg conv%',
      fmt: (r) => fmtPercent(r.dmgConvPct),
      title: DMG_CONV_DEF,
    },
    { key: 'ffDamage', label: 'FF', fmt: (r) => fmtInt(r.ffDamage) },
    {
      key: 'entryRate',
      label: 'Entry%',
      fmt: (r) => fmtPercent(r.entryRate),
      title: ENTRY_DEF,
    },
    {
      key: 'tradeRate',
      label: 'Trade%',
      fmt: (r) => fmtPercent(r.tradeRate),
      title: TRADE_DEF,
    },
    {
      key: 'untradedDeaths',
      label: 'Untraded D',
      fmt: (r) => String(r.untradedDeaths ?? 0),
      title: UNTRADED_DEF,
    },
    {
      key: 'tradeOppMissed',
      label: 'Trade opp missed',
      fmt: (r) => String(r.tradeOppMissed ?? 0),
      title: TRADE_OPP_MISSED_DEF,
      badge: TRADE_OPP_MISSED_DEF,
      inferred: true,
    },
    { key: 'kastPct', label: 'KAST%', fmt: (r) => fmtPercent(r.kastPct), title: KAST_DEF },
  ];

  const ENG_KINDS = ['', 'opening', 'entry', 'trade', 'untraded'];

  let clutches = $state([]);
  let engagements = $state([]);
  let stats = $state([]);
  let tickRate = $state(64);
  let error = $state('');

  let engKind = $state('');
  let statSort = $state({ key: 'kastPct', desc: true });

  // KAST drill-down modal (per-round K/A/T/S grid).
  let kastSteam = $state('');
  let kastName = $state('');
  let kastRows = $state([]);
  let kastLoading = $state(false);
  let kastError = $state('');

  $effect(() => {
    let live = true;
    Promise.all([
      getCombatStats(id),
      getClutches(id),
      getEngagements(id, ''),
      getMatch(id),
    ])
      .then(([cs, cl, en, m]) => {
        if (!live) return;
        stats = cs || [];
        clutches = cl || [];
        engagements = en || [];
        if (m && m.tickRate > 0) tickRate = m.tickRate;
        error = '';
      })
      .catch((e) => {
        if (live) error = errText(e);
      });
    return () => (live = false);
  });

  function errText(e) {
    if (e == null) return 'unknown error';
    if (typeof e === 'string') return e;
    return e.message || String(e);
  }

  const visibleEngagements = $derived(
    engKind ? engagements.filter((e) => e.kind === engKind) : engagements,
  );

  const sortedStats = $derived.by(() => {
    const { key, desc } = statSort;
    const rows = [...stats];
    rows.sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      let c;
      if (typeof av === 'string' || typeof bv === 'string') {
        c = String(av ?? '').localeCompare(String(bv ?? ''));
      } else {
        c = (av ?? 0) - (bv ?? 0);
      }
      return desc ? -c : c;
    });
    return rows;
  });

  function toggleStatSort(key) {
    if (statSort.key === key) statSort = { key, desc: !statSort.desc };
    else statSort = { key, desc: true };
  }

  function replay(tick) {
    setPendingSeek({ tick });
    nav(`/replay/${id}`);
  }

  function openRoundTimeline(round) {
    setPendingTimelineFilter({ round });
    nav(`/match/${id}/timeline`);
  }

  function isSteam(s) {
    return /^\d{17}$/.test(s || '');
  }

  function openProfile(steam) {
    if (isSteam(steam)) nav(`/player/${steam}`);
  }

  function wonByName(e) {
    if (e.wonBy === e.aSteam) return e.aName || e.wonBy || '—';
    if (e.wonBy === e.bSteam) return e.bName || e.wonBy || '—';
    return e.wonBy || '—';
  }

  // KAST% cell click → per-round K/A/T/S grid for that player.
  async function openKast(row) {
    kastSteam = row.steamId;
    kastName = row.name;
    kastRows = [];
    kastError = '';
    kastLoading = true;
    try {
      const rows = await getPlayerRounds(id, row.steamId);
      kastRows = (rows || []).slice().sort((a, b) => a.round - b.round);
    } catch (e) {
      kastError = errText(e);
    } finally {
      kastLoading = false;
    }
  }

  function closeKast() {
    kastSteam = '';
    kastRows = [];
    kastError = '';
  }

  function kastDotTitle(r, part) {
    const bits = [
      `round ${r.round}`,
      `${r.kills}K/${r.assists}A/${r.deaths}D`,
      r.traded ? 'traded' : null,
      r.survived ? 'survived' : null,
      r.kast ? 'KAST' : 'not KAST',
    ];
    return `${bits.filter(Boolean).join(' · ')} — ${part}`;
  }
</script>

<div class="comb-root">
  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <section class="panel comb-sec">
    <h2>
      Clutches <span class="chip provenance" title="clutch v2: alive-count analysis over stored events, replaces the M1 sole-survivor approximation">clutch v2</span>
    </h2>
    {#if clutches.length === 0 && !error}
      <p class="muted">No clutches detected in this match.</p>
    {:else}
      <div class="comb-grid">
        {#each clutches as c (c.id)}
          <ClutchCard clutch={c} {id} {nav} {tickRate} />
        {/each}
      </div>
    {/if}
  </section>

  <section class="panel comb-sec">
    <h2>Engagements</h2>
    <div class="comb-kinds" role="group" aria-label="Filter engagements by kind">
      {#each ENG_KINDS as k (k)}
        <button
          class="btn small comb-kind"
          class:active={engKind === k}
          onclick={() => (engKind = k)}
        >{k || 'all'}</button>
      {/each}
    </div>
    <div class="table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            <th scope="col"><span class="sr-only">Replay</span></th>
            <th scope="col" class="num">Tick</th>
            <th scope="col" class="num">Round</th>
            <th scope="col">Kind</th>
            <th scope="col">A</th>
            <th scope="col"><span class="sr-only">versus</span></th>
            <th scope="col">B</th>
            <th scope="col" class="num">Dist</th>
            <th scope="col">Won by</th>
          </tr>
        </thead>
        <tbody>
          {#each visibleEngagements as e, i (i)}
            <tr>
              <td>
                <button
                  class="btn small ghost"
                  title="Watch this engagement in the replay"
                  aria-label="Watch tick {e.tick} in the replay"
                  onclick={() => replay(e.tick)}
                >▶</button>
              </td>
              <td class="num mono">{e.tick}</td>
              <td class="num"><span class="chip round-chip">R{e.round}</span></td>
              <td>
                <span class="chip comb-kind-chip {e.kind}" title={ENG_KIND_TITLES[e.kind] || e.kind}>
                  {e.kind}
                </span>
              </td>
              <td>
                <button
                  class="comb-name-btn"
                  disabled={!isSteam(e.aSteam)}
                  title={isSteam(e.aSteam) ? `Open profile — ${e.aName}` : ''}
                  onclick={() => openProfile(e.aSteam)}
                >{e.aName || '—'}</button>
              </td>
              <td class="muted">vs</td>
              <td>
                <button
                  class="comb-name-btn"
                  disabled={!isSteam(e.bSteam)}
                  title={isSteam(e.bSteam) ? `Open profile — ${e.bName}` : ''}
                  onclick={() => openProfile(e.bSteam)}
                >{e.bName || '—'}</button>
              </td>
              <td class="num">{e.distance ? Math.round(e.distance) : '—'}</td>
              <td class="muted">{wonByName(e)}</td>
            </tr>
          {:else}
            <tr>
              <td colspan="9" class="muted">
                {error ? 'Engagements unavailable.' : 'No engagements match this filter.'}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <section class="panel comb-sec">
    <h2>Combat stats</h2>
    <div class="table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            {#each STAT_COLS as col (col.key)}
              <th
                scope="col"
                class="num"
                class:comb-def={col.title}
                title={col.title || ''}
              >
                <button
                  class="th-sort"
                  class:sorted={statSort.key === col.key}
                  aria-label="Sort by {col.label}"
                  onclick={() => toggleStatSort(col.key)}
                >
                  {col.label}{#if statSort.key === col.key}{statSort.desc ? ' ↓' : ' ↑'}{/if}
                </button>
                {#if col.inferred}
                  <span class="chip comb-inferred" title={col.badge}>inferred</span>
                {/if}
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each sortedStats as r (r.steamId)}
            <tr>
              {#each STAT_COLS as col (col.key)}
                {#if col.key === 'name'}
                  <td>
                    <button
                      class="comb-name-btn"
                      disabled={!isSteam(r.steamId)}
                      title={isSteam(r.steamId) ? 'Open player profile' : ''}
                      onclick={() => openProfile(r.steamId)}
                    >{r.name}</button>
                  </td>
                {:else if col.key === 'kastPct'}
                  <td class="num">
                    <button
                      class="comb-kast-btn"
                      title="{KAST_DEF} — click for the per-round K/A/T/S grid"
                      onclick={() => openKast(r)}
                    >{col.fmt(r)}</button>
                  </td>
                {:else}
                  <td class="num" title={col.title || ''}>{col.fmt(r)}</td>
                {/if}
              {/each}
            </tr>
          {:else}
            <tr><td colspan={STAT_COLS.length} class="muted">No combat stats.</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="muted comb-note">
      Dotted headers and <span class="chip comb-inferred">inferred</span> badges
      mark derived/heuristic metrics — hover for the rule text.
    </p>
  </section>

  {#if kastSteam}
    <div
      class="comb-modal-back"
      role="presentation"
      onclick={closeKast}
      onkeydown={(e) => e.key === 'Escape' && closeKast()}
    >
      <div
        class="comb-modal"
        role="dialog"
        aria-modal="true"
        aria-label="KAST rounds for {kastName}"
        tabindex="-1"
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => e.key === 'Escape' && closeKast()}
      >
        <div class="row-between">
          <h2>KAST rounds — {kastName}</h2>
          <button class="btn small" aria-label="Close" onclick={closeKast}>✕</button>
        </div>
        <p class="muted" title={KAST_DEF}>
          {#if kastRows.length > 0}
            {fmtPercent((kastRows.filter((r) => r.kast).length / kastRows.length) * 100)} KAST over
            {kastRows.length} rounds —
          {/if}
          dots = K kill · A assist · T traded · S survived (filled = applied).
        </p>
        {#if kastError}
          <p class="error" role="alert">{kastError}</p>
        {:else if kastLoading}
          <p class="muted">Loading…</p>
        {:else}
          <div class="comb-kast-grid">
            {#each kastRows as r (r.round)}
              <div class="comb-round" class:kast={r.kast} title={kastDotTitle(r, 'all parts')}>
                <span class="mono comb-round-n">R{r.round}</span>
                <span class="comb-dots">
                  <span class="comb-dot" class:on={r.kills > 0} title={kastDotTitle(r, 'kill')}>K</span>
                  <span class="comb-dot" class:on={r.assists > 0} title={kastDotTitle(r, 'assist')}>A</span>
                  <span class="comb-dot" class:on={r.traded} title={kastDotTitle(r, 'traded')}>T</span>
                  <span class="comb-dot" class:on={r.survived} title={kastDotTitle(r, 'survived')}>S</span>
                </span>
              </div>
            {:else}
              <p class="muted">No per-round rows for this player.</p>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
