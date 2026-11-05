<script>
  // Combat tab: per-player damage/trade stats, the engagement deep-dive
  // (round → time-into-round → killer vs victim → distance in metres) and
  // the WON clutches. Every inferred metric carries the badge with
  // its definition in the title attribute.
  import {
    getCombatStats,
    getClutches,
    getEngagements,
    getPlayerRounds,
    getRounds,
    getScoreboard,
    getMatch,
    errText,
  } from '../services.js';
  import { fmtInt, fmtPercent, roundClock } from '../fmt.js';
  import { replayHash } from '../nav.js';
  import { roundsByNumber } from '../replay/landmarks.js';
  import { playerStartClass, playerSideClassAt } from '../teams.js';
  import {
    KAST_DEF,
    DMG_CONV_DEF,
    ENTRY_DEF,
    TRADE_DEF,
    UNTRADED_DEF,
    TRADE_OPP_MISSED_DEF,
    ENG_DIST_DEF,
    ENG_KIND_TITLES,
  } from '../definitions.js';
  import Dialog from '../components/Dialog.svelte';
  import SortTh from '../components/SortTh.svelte';
  import EventPlay from '../components/EventPlay.svelte';
  import ProfileLink from '../components/ProfileLink.svelte';

  let { id = 0, nav = () => {} } = $props();

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

  // The engagement kinds the backend produces (analytics/engagements.go:
  // opening | trade | untraded — "entry" is deferred, see models.go).
  const ENG_KINDS = ['', 'opening', 'trade', 'untraded'];

  let clutches = $state([]);
  let engagements = $state([]);
  let stats = $state([]);
  let error = $state('');
  // Final side per player + the match's side-switch count: the inputs for
  // the team-identity colors on names. Scoreboard rows also carry the
  // exact-name fallback for rows without a steam id.
  let players = $state([]);
  let sideSwitches = $state(0);
  // Round list: the counted-round index behind the per-round side colors
  // on the engagement/clutch rows (lib/teams.js playerSideClassAt) and
  // the engagement row clock (roundClock: time INTO the round).
  let rounds = $state([]);
  let tickRate = $state(64);

  // number→row lookup behind the engagement row clock — the canonical
  // builder lib/replay/landmarks.js roundsByNumber (same as Utility's).
  const rbn = $derived(roundsByNumber(rounds));

  // Per-MATCH color for a name surface (the stats table, the KAST modal
  // header) — the team's start side, which never changes mid-match.
  function playerCls(steamId, name) {
    return playerStartClass(players, sideSwitches, steamId, name);
  }

  // Per-ROUND color for a row that belongs to ONE round (an engagement or
  // a clutch) — the side that player had in that round.
  function playerRoundCls(roundNumber, steamId, name) {
    return playerSideClassAt(players, sideSwitches, rounds, roundNumber, steamId, name);
  }

  let engKind = $state('');
  let statSort = $state({ key: 'kastPct', desc: true });

  // KAST drill-down modal (per-round K/A/T/S grid).
  let kastSteam = $state('');
  let kastName = $state('');
  let kastPct = $state(null); // the row's displayed KAST% (never recomputed)
  let kastRows = $state([]);
  let kastLoading = $state(false);
  let kastError = $state('');

  $effect(() => {
    let live = true;
    Promise.all([
      getCombatStats(id),
      getClutches(id),
      getEngagements(id, ''),
      getScoreboard(id, 'kills', true).catch(() => []),
      getMatch(id).catch(() => null),
      getRounds(id).catch(() => []),
    ])
      .then(([cs, cl, en, sb, m, rd]) => {
        if (!live) return;
        stats = cs || [];
        clutches = cl || [];
        engagements = en || [];
        players = sb || [];
        rounds = rd || [];
        sideSwitches = (m && m.sideSwitches) || 0;
        if (m && m.tickRate > 0) tickRate = m.tickRate;
        error = '';
      })
      .catch((e) => {
        if (live) error = errText(e);
      });
    return () => (live = false);
  });

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
    nav(replayHash(id, {}, { tick, back: `match/${id}/combat` }));
  }

  // Round chip → THE event browser scoped to that round.
  function openRoundEvents(round) {
    nav(replayHash(id, { round }, { back: `match/${id}/combat` }));
  }

  // The Clutches card lists WON clutches only (the card's scope decision):
  // a lost 1vN is dropped here rather than shown with an outcome chip, so
  // this derived filter is the one place that rule lives — lost rows are
  // simply not interesting here (their dead solos read 0 HP in
  // analytics/clutches.go, never the old clamped 1).
  const wonClutches = $derived(clutches.filter((c) => c.won));

  // KAST% cell click → per-round K/A/T/S grid for that player. The modal
  // header shows THIS row's kastPct — the exact value the column renders —
  // so the two can never disagree; the per-round grid below is the
  // breakdown behind it.
  async function openKast(row) {
    kastSteam = row.steamId;
    kastName = row.name;
    kastPct = Number.isFinite(row.kastPct) ? row.kastPct : null;
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
    kastPct = null;
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

<div class="view comb-view">
  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <section class="panel comb-sec">
    <h2>Combat stats</h2>
    <div class="table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            {#each STAT_COLS as col (col.key)}
              <SortTh
                label={col.label}
                cls={col.title ? 'num def' : 'num'}
                title={col.title || ''}
                active={statSort.key === col.key}
                desc={statSort.desc}
                onclick={() => toggleStatSort(col.key)}
              >
                {#if col.inferred}
                  <span class="chip badge-inferred" title={col.badge}>inferred</span>
                {/if}
              </SortTh>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each sortedStats as r (r.steamId)}
            <tr>
              {#each STAT_COLS as col (col.key)}
                {#if col.key === 'name'}
                  <td>
                    <ProfileLink
                      steam={r.steamId}
                      name={r.name}
                      {nav}
                      cls={playerCls(r.steamId, r.name)}
                      title="Open player profile"
                    />
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
      Dotted headers and <span class="chip badge-inferred">inferred</span> badges
      mark derived/heuristic metrics — hover for the rule text.
    </p>
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
            <th scope="col" class="num">Round</th>
            <th scope="col" class="num def" title="Time into the round — how far past the round's start tick the engagement happened (raw tick in the cell tooltip)">Time</th>
            <th scope="col">Kind</th>
            <th scope="col">Killer</th>
            <th scope="col"><span class="sr-only">versus</span></th>
            <th scope="col">Victim</th>
            <th scope="col" class="num def" title={ENG_DIST_DEF}>Dist (m)</th>
          </tr>
        </thead>
        <tbody>
          {#each visibleEngagements as e, i (i)}
            <tr>
              <td>
                <EventPlay
                  tick={e.tick}
                  title="Watch this engagement in the replay"
                  label="Watch tick {e.tick} in the replay"
                  onclick={() => replay(e.tick)}
                />
              </td>
              <td class="num">
                <button
                  class="btn small ghost"
                  title="Open round {e.round} in the replay landmark feed"
                  onclick={() => openRoundEvents(e.round)}
                >R{e.round}</button>
              </td>
              <td class="num mono" title="tick {e.tick}">{roundClock(e.tick, rbn.get(e.round), tickRate)}</td>
              <td>
                <span class="chip comb-kind-chip {e.kind}" title={ENG_KIND_TITLES[e.kind] || e.kind}>
                  {e.kind}
                </span>
              </td>
              <td>
                <ProfileLink
                  steam={e.aSteam}
                  name={e.aName || '—'}
                  {nav}
                  cls={playerRoundCls(e.round, e.aSteam, e.aName)}
                  title="Open profile — {e.aName}"
                />
              </td>
              <td class="muted">vs</td>
              <td>
                <ProfileLink
                  steam={e.bSteam}
                  name={e.bName || '—'}
                  {nav}
                  cls={playerRoundCls(e.round, e.bSteam, e.bName)}
                  title="Open profile — {e.bName}"
                />
              </td>
              <td class="num" title={ENG_DIST_DEF}>{e.distance ? Math.round(e.distance) : '—'}</td>
            </tr>
          {:else}
            <tr>
              <td colspan="8" class="muted">
                {error ? 'Engagements unavailable.' : 'No engagements match this filter.'}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <section class="panel comb-sec">
    <h2>
      Clutches <span class="chip provenance" title="Detected by alive-count analysis over the stored events: a 1vN starts when a side drops to one alive player while the opponents still have ≥ 1, and ends when the solo dies or the last opponent falls. WON clutches only — a lost 1vN is not listed.">alive-count · won only</span>
    </h2>
    {#if clutches.length === 0 && !error}
      <p class="muted" role="status">No clutches detected in this match.</p>
    {:else if wonClutches.length === 0}
      <p class="muted" role="status">No won clutches in this match.</p>
    {:else}
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th scope="col"><span class="sr-only">Replay</span></th>
              <th scope="col" class="num">Round</th>
              <th scope="col">Size</th>
              <th scope="col">Player</th>
              <th scope="col">Outcome</th>
              <th scope="col">Bomb</th>
              <th scope="col" class="num def" title="Remaining HP of the solo player when the clutch resolved: the game-sampled health of the last player_hurt at or before that moment (HP changes only through player_hurt, so the value is exact); rows without that detail fall back to damage arithmetic, and a dead solo reads 0">HP left</th>
            </tr>
          </thead>
          <tbody>
            {#each wonClutches as c (c.id)}
              <tr>
                <td>
                  {#if c.replayAnchorTick > 0}
                    <EventPlay
                      tick={c.replayAnchorTick}
                      title="Watch this clutch in the replay"
                      label="Watch the clutch in round {c.round} in the replay"
                      onclick={() => replay(c.replayAnchorTick)}
                    />
                  {/if}
                </td>
                <td class="num">
                  <button
                    class="btn small ghost"
                    title="Open round {c.round} in the replay landmark feed"
                    onclick={() => openRoundEvents(c.round)}
                  >R{c.round}</button>
                </td>
                <td><strong>1v{c.size}</strong></td>
                <td>
                  <ProfileLink
                    steam={c.steamId}
                    name={c.name || '—'}
                    {nav}
                    cls={playerRoundCls(c.round, c.steamId, c.name)}
                    title="Open player profile"
                  />
                </td>
                <td>
                  <span class="chip status {c.won ? 'ok' : 'bad'}">{c.won ? 'won' : 'lost'}</span>
                </td>
                <td>
                  {#if c.bombState && c.bombState !== 'none'}
                    <span class="chip">bomb {c.bombState}</span>
                  {:else}
                    <span class="muted">—</span>
                  {/if}
                </td>
                <td class="num">{c.hpLeft}</td>
              </tr>
            {:else}
              <tr><td colspan="7" class="muted">No won clutches in this match.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  <Dialog open={!!kastSteam} label="KAST rounds for {kastName}" panelClass="wide" onClose={closeKast}>
    <div class="row-between">
      <h2>
        KAST rounds —
        <ProfileLink
          steam={kastSteam}
          name={kastName}
          {nav}
          cls={playerCls(kastSteam, kastName)}
          title="Open {kastName} profile"
        />
      </h2>
      <button class="btn small" aria-label="Close" onclick={closeKast}><span class="codicon codicon-close"></span></button>
    </div>
    <p class="muted" title={KAST_DEF}>
      {#if kastRows.length > 0}
        {kastPct != null
          ? fmtPercent(kastPct)
          : fmtPercent((kastRows.filter((r) => r.kast).length / kastRows.length) * 100)} KAST over
        {kastRows.length} rounds —
      {/if}
      dots = K kill · A assist · T traded · S survived (filled = applied).
    </p>
    {#if kastError}
      <p class="error" role="alert">{kastError}</p>
    {:else if kastLoading}
      <p class="muted" role="status">Loading…</p>
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
          <p class="muted" role="status">No per-round rows for this player.</p>
        {/each}
      </div>
    {/if}
  </Dialog>
</div>
