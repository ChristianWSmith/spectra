<script>
  // Combat tab: per-player damage/trade stats, the engagement deep-dive
  // and detected clutches. Every inferred metric carries the badge with
  // its definition in the title attribute.
  import {
    getCombatStats,
    getClutches,
    getEngagements,
    getPlayerRounds,
    getScoreboard,
    getMatch,
    errText,
  } from '../services.js';
  import { fmtInt, fmtPercent } from '../fmt.js';
  import { replayHash } from '../nav.js';
  import { playerStartClass } from '../teams.js';
  import {
    KAST_DEF,
    DMG_CONV_DEF,
    ENTRY_DEF,
    TRADE_DEF,
    UNTRADED_DEF,
    TRADE_OPP_MISSED_DEF,
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
  // the team-identity colors on names (changes.txt #20). Scoreboard rows
  // also carry the exact-name fallback for rows without a steam id.
  let players = $state([]);
  let sideSwitches = $state(0);

  // Team-identity color class for a name surface — '' when the player or
  // their side can't be resolved (never a guessed color).
  function playerCls(steamId, name) {
    return playerStartClass(players, sideSwitches, steamId, name);
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
    ])
      .then(([cs, cl, en, sb, m]) => {
        if (!live) return;
        stats = cs || [];
        clutches = cl || [];
        engagements = en || [];
        players = sb || [];
        sideSwitches = (m && m.sideSwitches) || 0;
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

  // Round chip → THE event browser scoped to that round (the drill-down
  // used to be dead code pointing at the retired Timeline tab).
  function openRoundEvents(round) {
    nav(replayHash(id, { round }, { back: `match/${id}/combat` }));
  }

  function wonByName(e) {
    if (e.wonBy === e.aSteam) return e.aName || e.wonBy || '—';
    if (e.wonBy === e.bSteam) return e.bName || e.wonBy || '—';
    return e.wonBy || '—';
  }

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
                <EventPlay
                  tick={e.tick}
                  title="Watch this engagement in the replay"
                  label="Watch tick {e.tick} in the replay"
                  onclick={() => replay(e.tick)}
                />
              </td>
              <td class="num mono">{e.tick}</td>
              <td class="num">
                <button
                  class="btn small ghost"
                  title="Open round {e.round} in the replay landmark feed"
                  onclick={() => openRoundEvents(e.round)}
                >R{e.round}</button>
              </td>
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
                  cls={playerCls(e.aSteam, e.aName)}
                  title="Open profile — {e.aName}"
                />
              </td>
              <td class="muted">vs</td>
              <td>
                <ProfileLink
                  steam={e.bSteam}
                  name={e.bName || '—'}
                  {nav}
                  cls={playerCls(e.bSteam, e.bName)}
                  title="Open profile — {e.bName}"
                />
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
    <h2>
      Clutches <span class="chip provenance" title="Detected by alive-count analysis over the stored events: a 1vN starts when a side drops to one alive player while the opponents still have ≥ 1, and ends when the solo dies or the last opponent falls">alive-count</span>
    </h2>
    {#if clutches.length === 0 && !error}
      <p class="muted" role="status">No clutches detected in this match.</p>
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
              <th scope="col" class="num">HP left</th>
            </tr>
          </thead>
          <tbody>
            {#each clutches as c (c.id)}
              <tr>
                <td>
                  <EventPlay
                    tick={c.replayAnchorTick || c.startTick}
                    title="Watch this clutch in the replay"
                    label="Watch the clutch in round {c.round} in the replay"
                    onclick={() => replay(c.replayAnchorTick || c.startTick)}
                  />
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
                    cls={playerCls(c.steamId, c.name)}
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
              <tr><td colspan="7" class="muted">No clutches detected in this match.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  <Dialog open={!!kastSteam} label="KAST rounds for {kastName}" panelClass="wide" onClose={closeKast}>
    <div class="row-between">
      <h2>KAST rounds — <span class={playerCls(kastSteam, kastName)}>{kastName}</span></h2>
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
