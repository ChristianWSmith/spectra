<script>
  // Combat tab: per-player damage/trade stats, the engagement deep-dive
  // (round → time-into-round → killer vs victim → distance in metres —
  // ONE row per KILL: a kill's independent kind facts — e.g. trade +
  // traded — share the one row, both chips in its Kind cell) and the
  // clutches (won/lost toggle — won ON, lost OFF by default). Every
  // inferred metric carries the badge with its definition in the title
  // attribute.
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
  import { replayHash, entryLoopSpanAround, entryLoopAround } from '../nav.js';
  import { listedPlayers } from '../players.js';
  import { roundsByNumber } from '../replay/landmarks.js';
  import { playerStartClass, playerSideClassAt } from '../teams.js';
  import { seed, remember, matchKey } from '../viewstate.svelte.js';
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
    { key: 'dmgNoKill', label: 'Damage (no kill)', fmt: (r) => fmtInt(r.dmgNoKill) },
    {
      key: 'dmgConvPct',
      label: 'Kill conversion %',
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
      label: 'Untraded deaths',
      fmt: (r) => String(r.untradedDeaths ?? 0),
      title: UNTRADED_DEF,
    },
    {
      key: 'tradeOppMissed',
      label: 'Missed trades',
      fmt: (r) => String(r.tradeOppMissed ?? 0),
      title: TRADE_OPP_MISSED_DEF,
      badge: TRADE_OPP_MISSED_DEF,
      inferred: true,
    },
    { key: 'kastPct', label: 'KAST%', fmt: (r) => fmtPercent(r.kastPct), title: KAST_DEF },
  ];

  // The engagement kinds the backend produces (analytics/engagements.go:
  // opening | trade | traded | untraded — "entry" is deferred, see
  // models.go). "traded" is the victim-side ANSWERED fact — the natural
  // pair of untraded — so every kill yields ≥ 1 row: exactly one
  // victim-side row (traded OR untraded) plus the killer-side facts.
  const ENG_KINDS = ['', 'opening', 'trade', 'traded', 'untraded'];

  let clutches = $state([]);
  let engagements = $state([]);
  let stats = $state([]);
  let error = $state('');
  // Rung 3 of the loading ladder: without it every panel below renders as an
  // empty table while the one Promise.all above is in flight — a false
  // "no data" state. Plain indicator, transient (never seeded/remembered,
  // never in the URL); cleared once on the first settled read.
  let loading = $state(true);
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

  // View-local filter/sort state (kind chips, clutch won/lost, stat
  // sort) restores per match through the process-scoped registry
  // (viewstate.svelte.js): the key carries the match id (matchKey), so
  // match A's filters never seed into match B. App's {#if} chain reuses
  // this component when only the id changes (no remount), so ONE
  // combined effect both RE-SEEDS when the key changes and writes
  // through otherwise — self-ordering: the write branch runs only while
  // the key is unchanged, so the old match's values can never land
  // under the new key. KAST drill-down, busy/error stay transient.
  const combDefaults = () => ({
    engKind: '',
    clutchWon: true,
    clutchLost: false,
    statSort: { key: 'kastPct', desc: true },
  });
  const combKey = $derived(matchKey('combat', id));
  // Deliberate ONE-TIME init capture: the derived is read inside a closure
  // (Svelte's documented state_referenced_locally fix); the snapshot carries
  // the key so lastKey matches without a second top-level derived read.
  // The combined reseed/write-through $effect below owns every later key
  // change — URL stays the sole durable record; registry semantics unchanged.
  const combInit = () => ({ ...seed(combKey, combDefaults()), key: combKey });
  const combSeed = combInit();
  let engKind = $state(combSeed.engKind);
  // Clutches card outcome toggle — LOCAL state only: never stamped into
  // the URL (the route-query retention ruling resolved to the
  // process-scoped registry below): won ON and lost OFF by default, i.e.
  // the card's historical won-only scope preserved, with lost rows one
  // click away. Independent booleans (not one enum) so both ON lists
  // every clutch and both OFF empties the card.
  let clutchWon = $state(combSeed.clutchWon);
  let clutchLost = $state(combSeed.clutchLost);
  let statSort = $state(combSeed.statSort);
  let combLastKey = combSeed.key;
  $effect(() => {
    const k = combKey;
    if (k !== combLastKey) {
      // The view moved to ANOTHER match without remounting: apply the
      // new key's record (defaults when it has none) and do not write —
      // the entry keeps exactly what was applied, so the old match's
      // values can never land under the new key (the write-through
      // re-arms on the next user change, which reads the re-seeded
      // values).
      combLastKey = k;
      const s = seed(k, combDefaults());
      engKind = s.engKind;
      clutchWon = s.clutchWon;
      clutchLost = s.clutchLost;
      statSort = s.statSort;
      return;
    }
    remember(k, { engKind, clutchWon, clutchLost, statSort });
  });

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
        stats = listedPlayers(cs) || [];
        clutches = cl || [];
        engagements = en || [];
        players = listedPlayers(sb) || [];
        rounds = rd || [];
        sideSwitches = (m && m.sideSwitches) || 0;
        if (m && m.tickRate > 0) tickRate = m.tickRate;
        error = '';
        loading = false;
      })
      .catch((e) => {
        if (live) {
          error = errText(e);
          loading = false;
        }
      });
    return () => (live = false);
  });

  // ONE rendered row per KILL. analytics/engagements.go emits up to
  // FOUR rows for a single kill event — opening / trade / traded /
  // untraded are independent detections over the SAME event
  // (analytics_test.go TestEngagementsKinds pins one kill producing the
  // trade row AND a victim-side row) and EVERY kill yields ≥ 1 row
  // (exactly one victim-side row: traded OR untraded); every row of one
  // kill carries the same round, tick, killer, victim and distance; only
  // Kind differs. Two look-alike rows were therefore dual-semantics, not
  // a duplicate emission: the owner ruled they merge into ONE row whose
  // Kind cell carries both facts (Go keeps emitting per-kind rows — the
  // stats consume those verbatim; the merge is presentation-only).
  //
  // Grouping key: round | tick | killer | victim. A same-tick same-pair
  // double kill cannot occur: every engagement row derives from ONE
  // player_death event, a victim dies at most once per round, and a
  // single kill emits at most one row per kind (opening once per round
  // via firstKillDone; trade/traded/untraded single emits) — so a group
  // is exactly one kill and its kinds are distinct.
  //
  // Sort: a merged row keeps its FIRST member's position. The fetch is
  // GetEngagements ORDER BY seq (store/analytics.go; seq was written in
  // round → tick → kind order with opening < trade < traded < untraded),
  // so Map
  // insertion order — first appearance in that sorted stream — preserves
  // the round/tick ordering exactly: the merged row sits where its
  // earliest (lowest-kind) row used to, and nothing else moves.
  const engagementRows = $derived.by(() => {
    const groups = new Map();
    for (const e of engagements) {
      const key = `${e.round}|${e.tick}|${e.aSteam}|${e.bSteam}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          key,
          round: e.round,
          tick: e.tick,
          aSteam: e.aSteam,
          aName: e.aName,
          bSteam: e.bSteam,
          bName: e.bName,
          distance: e.distance,
          kinds: [],
        };
        groups.set(key, g);
      }
      // Distinct kinds only (one kill emits each kind at most once);
      // push keeps the fetch's opening → trade → traded → untraded order.
      if (!g.kinds.includes(e.kind)) g.kinds.push(e.kind);
    }
    return [...groups.values()];
  });

  // The kind chips FILTER the merged rows: a row matches when it
  // CONTAINS that kind — a trade+untraded kill shows under either chip
  // (and once, not twice, under "all").
  const visibleEngagements = $derived(
    engKind ? engagementRows.filter((g) => g.kinds.includes(engKind)) : engagementRows,
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

  // Deep link into the replay at a tick, with an optional entry-only
  // ?loop= range stamped beside it (undefined = none): ±10 s around an
  // engagement tick (singular event), the clutch's kill-span padded ±10 s
  // (long event — clutchLoop below). `follow` is the ROW'S ACTOR (entry
  // context, never a filter): the engagement's killer, the clutch's solo
  // — absent actor → undefined, which buildHash drops (never a guessed
  // follow).
  function replay(tick, loop, follow) {
    // `|| undefined` — buildHash drops null/undefined but would keep an
    // empty string as `follow=`; an actor-less row stamps NOTHING.
    nav(replayHash(id, {}, { tick, loop, follow: follow || undefined, back: `match/${id}/combat` }));
  }

  // The Clutches card lists the clutches its WON/LOST toggles select
  // (owner ruling: won ON, lost OFF by default — today's won-only scope
  // is just the default state). Both ON = every clutch; both OFF = the
  // empty state. This derived filter is the one place that rule lives.
  // A lost 1vN is listed with its outcome chip rather than dropped (their
  // dead solos read 0 HP in analytics/clutches.go, never the old clamped 1).
  const shownClutches = $derived(
    clutches.filter((c) => (c.won ? clutchWon : clutchLost)),
  );

  // Filter-aware empty state for the Clutches card: names exactly what
  // the current toggle selection asked for ("No won clutches…" keeps the
  // default-state wording), and with both outcomes off it says so rather
  // than pretending the match had none (that case is the `clutches.length
  // === 0` branch above).
  const clutchEmptyText = $derived(
    !clutchWon && !clutchLost
      ? 'No clutch outcome selected — toggle won or lost above.'
      : clutchWon && !clutchLost
        ? 'No won clutches in this match.'
        : !clutchWon && clutchLost
          ? 'No lost clutches in this match.'
          : 'No clutches in this match.',
  );

  // Parse a ClutchRow.killTicks value: Go ships it as a JSON array of
  // int ticks (models.Clutch.KillTicks — the SOLO's kills strictly after
  // the clutch started), so the string is the wire form. Anything
  // unparseable / non-array / non-numeric reads as NO kills — never a
  // guessed tick (the caller falls back to the padded span).
  function clutchKillTicks(raw) {
    if (typeof raw !== 'string' || raw === '') return [];
    let v;
    try {
      v = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(v)) return [];
    return v.map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  }

  // The clutch row's ?loop= — the owner's LONG-EVENT rule: 10 s before
  // the FIRST kill of the clutch to 10 s after the LAST kill of it
  // (nav.entryLoopSpanAround is THE stamper for that shape; both bounds
  // padded at the match tick rate, floored at 0, undefined when a bound
  // is unstatable — buildHash then drops ?loop= entirely, never a
  // partial promise).
  //
  // First/last kill come from ClutchRow.killTicks (the solo's kills
  // AFTER the start) — chosen over re-deriving them from the engagements
  // fetch: the DTO already ships them, so there is no second data path
  // to keep in step, and the window semantics fall out structurally.
  // Window semantics (golden round 7, inferno): the clutch SPAN opens at
  // the teammate's death that made it a 1vN (~13:34) while the solo's
  // first kill is ~14:10 and the last ~14:18 — the creating kill is NOT
  // the solo's, so killTicks (attacker === solo, tick > startTick) can
  // never include it, and the wanted loop 14:00–14:28 falls out of
  // first−10 s / last+10 s without a special case. A won clutch whose
  // solo has NO kill in the span (bomb/time wins) has an empty killTicks
  // → fall back to the raw clutch span padded the SAME ±10 s (owner's
  // fallback ruling) — never the bare span.
  function clutchLoop(c) {
    const kills = clutchKillTicks(c.killTicks);
    if (kills.length > 0) {
      const first = Math.min(...kills);
      const last = Math.max(...kills);
      return entryLoopSpanAround(first, last, tickRate);
    }
    return entryLoopSpanAround(c.startTick, c.endTick, tickRate);
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
    <p class="error" role="alert">
      {error}
      <button class="btn small" aria-label="Dismiss error" onclick={() => (error = '')}>
        <span class="codicon codicon-close"></span>
      </button>
    </p>
  {/if}

  {#if loading}
    <!-- All three panels below come from ONE Promise.all: until it
         settles, empty tables would be a false "no data" state — rung 3
         of the loading ladder (plain indicator, transient). -->
    <p class="muted" role="status">Loading combat data…</p>
  {:else}
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
              <!-- Honesty gate: a FAILED load must not claim the match
                   has no combat stats (the error above says why nothing
                   is here); the claim returns once error is cleared. -->
              {#if !error}
                <tr><td colspan={STAT_COLS.length} class="muted">No combat stats.</td></tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
      <p class="muted comb-note">
        Dotted headers and <span class="chip badge-inferred">inferred</span> badges
        mark stats Spectra calculates rather than reads from the demo — hover for
        the rule.
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
              <th scope="col" class="num def" title="Time into the round — how far past the round's start tick the engagement happened (exact tick in the tooltip)">Time</th>
              <th scope="col">Kind</th>
              <th scope="col">Killer</th>
              <th scope="col"><span class="sr-only">versus</span></th>
              <th scope="col">Victim</th>
              <th scope="col" class="num def" title={ENG_DIST_DEF}>Dist (m)</th>
            </tr>
          </thead>
          <tbody>
            {#each visibleEngagements as g (g.key)}
              <tr>
                <td>
                  <!-- Row ▶ follows the ENGAGEMENT's KILLER (the owner's
                       rule: the play button on a kill follows the killer). -->
                  <EventPlay
                    tick={g.tick}
                    title={g.aSteam
                      ? `Watch this engagement — follow ${g.aName || g.aSteam} (killer)`
                      : 'Watch this engagement in the replay'}
                    label={g.aSteam
                      ? `Watch tick ${g.tick} — follow ${g.aName || g.aSteam}`
                      : `Watch tick ${g.tick} in the replay`}
                    onclick={() => replay(g.tick, entryLoopAround(g.tick, tickRate), g.aSteam)}
                  />
                </td>
                <!-- The Round cell is TEXT, not a control (owner ruling:
                     "no round play button there"): RD{n} as a plain label —
                     a label isn't a play button, and the row's ONE ▶ is the
                     event/follow play above. Round watching lives in the
                     RoundDetail header's "Watch round". -->
                <td class="num">RD{g.round}</td>
                <td class="num mono" title="tick {g.tick}">{roundClock(g.tick, rbn.get(g.round), tickRate)}</td>
                <td>
                  <!-- ONE kill, up to FOUR kind facts (opening / trade /
                       traded / untraded — every kill yields ≥ 1 row): the
                       kinds are independent detections over the same kill
                       event (see engagementRows above), so a merged row
                       wears its chips side by side — each keeping its own
                       perspective title — plus an sr-only combined line,
                       making the cell read as one kill with its facts
                       rather than as two rows' worth of labels. -->
                  {#each g.kinds as k, i (k)}{#if i > 0}{' · '}{/if}<span class="chip comb-kind-chip {k}" title={ENG_KIND_TITLES[k] || k}>{k}</span>{/each}{#if g.kinds.length > 1}{' '}<span class="sr-only">One kill — {g.kinds.map((k) => ENG_KIND_TITLES[k] || k).join('; ')}</span>{/if}
                </td>
                <td>
                  <ProfileLink
                    steam={g.aSteam}
                    name={g.aName || '—'}
                    {nav}
                    cls={playerRoundCls(g.round, g.aSteam, g.aName)}
                    title="Open profile — {g.aName}"
                  />
                </td>
                <td class="muted">vs</td>
                <td>
                  <ProfileLink
                    steam={g.bSteam}
                    name={g.bName || '—'}
                    {nav}
                    cls={playerRoundCls(g.round, g.bSteam, g.bName)}
                    title="Open profile — {g.bName}"
                  />
                </td>
                <td class="num" title={ENG_DIST_DEF}>{g.distance ? Math.round(g.distance) : '—'}</td>
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
        Clutches <span class="chip provenance" title="Found by counting who is alive when the side drops to one player while the opponents still have ≥ 1; it ends when the solo dies or the last opponent falls. Shown per the won/lost toggle below (won on, lost off by default).">alive-count · won/lost toggle</span>
      </h2>
      <!-- Outcome TOGGLES — chip-style like the Engagements card's kind
           chips, but independent (each flips its own boolean): won+lost = all
           rows, won-only = the default/historical list, lost-only = the lost
           rows, neither = the empty state below. Local $state only — never
           route-query state (retention ruling pending). -->
      <div class="comb-kinds" role="group" aria-label="Filter clutches by outcome">
        <button
          class="btn small comb-kind"
          class:active={clutchWon}
          aria-pressed={clutchWon}
          onclick={() => (clutchWon = !clutchWon)}
        >won</button>
        <button
          class="btn small comb-kind"
          class:active={clutchLost}
          aria-pressed={clutchLost}
          onclick={() => (clutchLost = !clutchLost)}
        >lost</button>
      </div>
      {#if clutches.length === 0 && !error}
        <p class="muted" role="status">No clutches detected in this match.</p>
      {:else if shownClutches.length === 0}
        <p class="muted" role="status">{clutchEmptyText}</p>
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
                <th scope="col" class="num def" title="Remaining HP of the solo player when the clutch resolved: the last recorded health before the round ended (rows without that detail fall back to damage arithmetic, and a dead solo reads 0)">HP left</th>
              </tr>
            </thead>
            <tbody>
              {#each shownClutches as c (c.id)}
                <tr>
                  <td>
                    {#if c.replayAnchorTick > 0}
                      <!-- Row ▶ follows the CLUTCH's solo (the row actor);
                           the loop is the KILL-span ±10 s (clutchLoop). -->
                      <EventPlay
                        tick={c.replayAnchorTick}
                        title={c.steamId
                          ? `Watch this clutch — follow ${c.name || c.steamId}`
                          : 'Watch this clutch in the replay'}
                        label={c.steamId
                          ? `Watch the clutch in round ${c.round} — follow ${c.name || c.steamId}`
                          : `Watch the clutch in round ${c.round} in the replay`}
                        onclick={() => replay(c.replayAnchorTick, clutchLoop(c), c.steamId)}
                      />
                    {/if}
                  </td>
                  <!-- Same ruling as the engagement row: the Round cell is
                       the RD{n} label, never a second play button. -->
                  <td class="num">RD{c.round}</td>
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
                <tr><td colspan="7" class="muted">{clutchEmptyText}</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>
  {/if}

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
            <span class="mono comb-round-n">RD{r.round}</span>
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
