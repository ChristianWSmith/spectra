<script>
  import * as S from '../strings/index.js';
  // Combat tab: the engagement deep-dive
  // (round → time-into-round → killer vs victim → distance in metres —
  // ONE row per KILL: a kill's independent kind facts — e.g. trade +
  // traded — share the one row, both chips in its Kind cell; the kind
  // TOGGLES are independent/OR'd and ALL OFF by default = no filter,
  // every row; the round <select> narrows the same list — 'all' by
  // default — and rides the Engagements card only) and the clutches
  // (won/lost toggle — won ON, lost OFF by default).
  import {
    getClutches,
    getEngagements,
    getRounds,
    getScoreboard,
    getMatch,
    getPref,
    errText,
  } from '../services.js';
  import { onMount } from 'svelte';
  import { roundClock } from '../fmt.js';
  import {
    replayHash,
    entryLoopSpanAround,
    entryLoopAround,
    LOOP_SECS_DEFAULT,
    prefLoopSecs,
  } from '../nav.js';
  import { listedPlayers } from '../players.js';
  import { roundScoreLabel } from '../rounds.js';
  import { roundsByNumber } from '../replay/landmarks.js';
  import { playerSideClassAt } from '../teams.js';
  import { seed, remember, matchKey } from '../viewstate.svelte.js';
  import {
    ENG_DIST_DEF,
    ENG_KIND_TITLES,
  } from '../definitions.js';
  import EventPlay from '../components/EventPlay.svelte';
  import ProfileLink from '../components/ProfileLink.svelte';
  import StatusChip from '../components/StatusChip.svelte';
  import TokenSelect from '../components/TokenSelect.svelte';

  let { id = 0, nav = () => {} } = $props();

  // The engagement kinds the backend produces (analytics/engagements.go:
  // opening | trade | traded | untraded — "entry" is deferred, see
  // models.go). "traded" is the victim-side ANSWERED fact — the natural
  // pair of untraded — so every kill yields ≥ 1 row: exactly one
  // victim-side row (traded OR untraded) plus the killer-side facts.
  // No '' / "all" entry: the toggles below are independent selections
  // and every toggle OFF is the no-filter default.
  const ENG_KINDS = ['opening', 'trade', 'traded', 'untraded'];

  let clutches = $state([]);
  let engagements = $state([]);
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

  // Event-level loop length: the `loop_secs` pref (Settings → Replay),
  // read ONCE at mount — nav.prefLoopSecs coerces it (unset/corrupt →
  // LOOP_SECS_DEFAULT), so the engagement ▶ (singular event) and the
  // clutch ▶ (long event) both stamp the width the replay's quick-range
  // button arms.
  let loopSecs = LOOP_SECS_DEFAULT;
  onMount(() => {
    getPref('loop_secs')
      .then((v) => (loopSecs = prefLoopSecs(v)))
      .catch(() => {
        /* keep the default */
      });
  });

  // number→row lookup behind the engagement row clock — the canonical
  // builder lib/replay/landmarks.js roundsByNumber (same as Utility's).
  const rbn = $derived(roundsByNumber(rounds));

  // Per-ROUND color for a row that belongs to ONE round (an engagement or
  // a clutch) — the side that player had in that round.
  function playerRoundCls(roundNumber, steamId, name) {
    return playerSideClassAt(players, sideSwitches, rounds, roundNumber, steamId, name);
  }

  // View-local filter state (kind chips, the round scope, clutch
  // won/lost) restores per match through the process-scoped
  // registry (viewstate.svelte.js): the key carries the match id
  // (matchKey), so match A's filters never seed into match B. App's {#if}
  // chain reuses this component when only the id changes (no remount), so
  // ONE combined effect both RE-SEEDS when the key changes and writes
  // through otherwise — self-ordering: the write branch runs only while
  // the key is unchanged, so the old match's values can never land under
  // the new key. busy/error stay transient.
  const combDefaults = () => ({
    // Engagements: an ARRAY of active kind toggles — [] (all off) is
    // the no-filter default (every row), not an empty card. A stale
    // scalar `engKind` entry fails sameKind's array check and is
    // whitelisted away — no migration.
    engKinds: [],
    // The engagements ROUND scope (owner answer Q2, 2026-11-16; W17
    // multi-select, owner 2026-11-16): an ARRAY of picked rounds on the
    // Engagements card ONLY — the Clutches card
    // gets none (the criterion is that the round picker
    // scopes the kill-by-kill list it sits on). [] (the default) is the
    // no-filter value — the kind toggles' all-off rule applies here
    // too: a fresh card shows every row — and a picked set ORs those
    // rounds together. Unlike the throw log's preselect (Q1), nothing
    // narrows by default. The old scalar `engRound` ('all'/round-as-
    // text) fails sameKind's array check and never surfaces — no
    // migration.
    engRounds: [],
    clutchWon: true,
    clutchLost: false,
  });
  const combKey = $derived(matchKey('combat', id));
  // Deliberate ONE-TIME init capture: the derived is read inside a closure
  // (Svelte's documented state_referenced_locally fix); the snapshot carries
  // the key so lastKey matches without a second top-level derived read.
  // The combined reseed/write-through $effect below owns every later key
  // change — URL stays the sole durable record; registry semantics unchanged.
  const combInit = () => ({ ...seed(combKey, combDefaults()), key: combKey });
  const combSeed = combInit();
  let engKinds = $state(combSeed.engKinds);
  // The Engagements round scope: [] (no filter — the default) or the
  // picked round numbers (the sanctioned TokenSelect multi-select's
  // set semantics); see combDefaults.
  let engRounds = $state(combSeed.engRounds);
  // Clutches card outcome toggle — LOCAL state only: never stamped into
  // the URL (the route-query retention ruling resolved to the
  // process-scoped registry below): won ON and lost OFF by default, i.e.
  // the card's historical won-only scope preserved, with lost rows one
  // click away. Independent booleans (not one enum) so both ON lists
  // every clutch and both OFF empties the card.
  let clutchWon = $state(combSeed.clutchWon);
  let clutchLost = $state(combSeed.clutchLost);
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
      engKinds = s.engKinds;
      engRounds = s.engRounds;
      clutchWon = s.clutchWon;
      clutchLost = s.clutchLost;
      return;
    }
    remember(k, { engKinds, engRounds, clutchWon, clutchLost });
  });

  $effect(() => {
    let live = true;
    Promise.all([
      getClutches(id),
      getEngagements(id, ''),
      getScoreboard(id, 'kills', true).catch(() => []),
      getMatch(id).catch(() => null),
      getRounds(id).catch(() => []),
    ])
      .then(([cl, en, sb, m, rd]) => {
        if (!live) return;
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

  // The kind TOGGLES filter the merged rows as an OR UNION: a row
  // matches when it CONTAINS ANY selected kind — a trade+untraded kill
  // shows under either toggle and once (not twice) under both. With
  // every toggle off (the default) there is no kind filter at all. The
  // round scope (owner answer Q2; W17 multi-select, owner 2026-11-16)
  // narrows the SAME list to the picked SET — an empty set (the
  // default) is no round filter either, and a picked set ORs those
  // rounds together (RD7 selected alone shows round 7; adding RD6
  // unions it in). Both predicates compose over the fetch order of
  // engagementRows, which is preserved.
  const engRoundOptions = $derived(
    [...new Set(engagementRows.map((g) => g.round))].sort((a, b) => a - b),
  );
  // The TokenSelect universe: one {id, label} per round with a kill —
  // labels the canonical `RD<n> | <ct>-<t>` (roundScoreLabel), so the
  // type-to-search box searches the same words it shows.
  const engRoundItems = $derived(
    engRoundOptions.map((n) => ({ id: n, label: roundScoreLabel(rounds, n) })),
  );
  const visibleEngagements = $derived(
    engagementRows.filter(
      (g) =>
        (engKinds.length === 0 || g.kinds.some((k) => engKinds.includes(k))) &&
        (engRounds.length === 0 || engRounds.includes(g.round)),
    ),
  );

  // Each click adds its kind to the selection or removes it (the
  // Clutches card's independent-toggle shape): deselecting everything
  // lands back on the all-off default = no filter. The round scope
  // toggles the same way through TokenSelect's pick/remove pair.
  function toggleEngKind(k) {
    engKinds = engKinds.includes(k) ? engKinds.filter((x) => x !== k) : [...engKinds, k];
  }
  function toggleEngRound(n) {
    engRounds = engRounds.includes(n) ? engRounds.filter((x) => x !== n) : [...engRounds, n];
  }

  // Deep link into the replay at a tick, with an optional entry-only
  // ?loop= range stamped beside it (undefined = none): the loop length
  // around an engagement tick (singular event), the clutch's kill-span
  // padded by the same length (long event — clutchLoop below), both
  // from the `loop_secs` pref. `follow` is the ROW'S ACTOR (entry
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

  // The clutch row's ?loop= — the owner's LONG-EVENT rule: the loop
  // length before the FIRST kill of the clutch to the same length after
  // the LAST kill of it (nav.entryLoopSpanAround is THE stamper for that
  // shape; the length is the `loop_secs` pref — loopSecs above — padded
  // at the match tick rate, floored at 0, undefined when a bound
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
  // first−loop / last+loop without a special case. A won clutch whose
  // solo has NO kill in the span (bomb/time wins) has an empty killTicks
  // → fall back to the raw clutch span padded the SAME loop length
  // (owner's fallback ruling) — never the bare span.
  function clutchLoop(c) {
    const kills = clutchKillTicks(c.killTicks);
    if (kills.length > 0) {
      const first = Math.min(...kills);
      const last = Math.max(...kills);
      return entryLoopSpanAround(first, last, tickRate, loopSecs);
    }
    return entryLoopSpanAround(c.startTick, c.endTick, tickRate, loopSecs);
  }
</script>

<div class="view comb-view">
  {#if error}
    <p class="error" role="alert">
      {error}
      <button class="btn small" aria-label={S.combat.dismissError} onclick={() => (error = '')}>
        <span class="codicon codicon-close"></span>
      </button>
    </p>
  {/if}

  {#if loading}
    <!-- Both panels below come from ONE Promise.all: until it
         settles, empty tables would be a false "no data" state — rung 3
         of the loading ladder (the bare fallback's centered spinner +
         details underneath, transient). -->
    <p class="muted" role="status"><StatusChip block detail={S.combat.loadingDetail} /></p>
  {:else}
    <section class="panel comb-sec">
      <h2>{S.combat.engagementsHeading}</h2>
      <div class="comb-kinds" role="group" aria-label={S.combat.filterEngagementsLabel}>
        {#each ENG_KINDS as k (k)}
          <button
            class="btn small comb-kind"
            class:active={engKinds.includes(k)}
            aria-pressed={engKinds.includes(k)}
            onclick={() => toggleEngKind(k)}
          >{k}</button>
        {/each}
        <!-- The ONE round scope (owner answer Q2): Engagements only —
             the Clutches card carries none. W17
             (owner, 2026-11-16): the single <select> became the
             sanctioned TokenSelect MULTI-select — picked rounds land as
             chips in the field (type to search the canonical
             `RD<n> | <ct>-<t>` labels), an empty set = ALL rounds (the
             kind toggles' all-off rule), a picked set ORs those rounds
             together. The visible "Round" label moved onto the control
             as its aria-label (W7) — no empty label element left
             behind. -->
        <div class="comb-round-filter">
          <TokenSelect
            id="comb-round-filter"
            items={engRoundItems}
            text={(it) => it.label}
            tokens={engRounds.map((n) => ({ id: n, label: roundScoreLabel(rounds, n) }))}
            ariaLabel={S.combat.roundFilterLabel}
            onselect={(it) => toggleEngRound(it.id)}
            onremove={(n) => toggleEngRound(n)}
          />
        </div>
      </div>
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th scope="col"><span class="sr-only">{S.combat.thReplay}</span></th>
              <th scope="col" class="num">{S.combat.thRound}</th>
              <th scope="col" class="num def" title={S.combat.timeTitle}>{S.combat.thTime}</th>
              <th scope="col">{S.combat.thKind}</th>
              <th scope="col">{S.combat.thKiller}</th>
              <th scope="col"><span class="sr-only">{S.combat.thVersus}</span></th>
              <th scope="col">{S.combat.thVictim}</th>
              <th scope="col" class="num def" title={ENG_DIST_DEF}>{S.combat.thDist}</th>
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
                      : S.combat.watchEngagement}
                    label={g.aSteam
                      ? `Watch tick ${g.tick} — follow ${g.aName || g.aSteam}`
                      : `Watch tick ${g.tick} in the replay`}
                    onclick={() => replay(g.tick, entryLoopAround(g.tick, tickRate, loopSecs), g.aSteam)}
                  />
                </td>
                <!-- The Round cell is TEXT, not a control (owner ruling:
                     "no round play button there"): the bare round number
                     under the RD heading — a label isn't a play button,
                     and the row's ONE ▶ is the event/follow play above.
                     Round watching lives in the RoundDetail header's
                     "Watch round". -->
                <td class="num">{g.round}</td>
                <td class="num mono" title={S.fill(S.combat.tickTitle, { tick: g.tick })}>{roundClock(g.tick, rbn.get(g.round), tickRate)}</td>
                <td>
                  <!-- ONE kill, up to FOUR kind facts (opening / trade /
                       traded / untraded — every kill yields ≥ 1 row): the
                       kinds are independent detections over the same kill
                       event (see engagementRows above), so a merged row
                       wears its chips side by side — each keeping its own
                       perspective title — plus an sr-only combined line,
                       making the cell read as one kill with its facts
                       rather than as two rows' worth of labels. -->
                  {#each g.kinds as k, i (k)}{#if i > 0}{' · '}{/if}<span class="chip comb-kind-chip {k}" title={ENG_KIND_TITLES[k] || k}>{k}</span>{/each}{#if g.kinds.length > 1}{' '}<span class="sr-only">{S.combat.oneKillPrefix}{g.kinds.map((k) => ENG_KIND_TITLES[k] || k).join('; ')}</span>{/if}
                </td>
                <td>
                  <ProfileLink
                    steam={g.aSteam}
                    name={g.aName || '—'}
                    {nav}
                    cls={playerRoundCls(g.round, g.aSteam, g.aName)}
                    title={S.fill(S.combat.openProfileName, { name: g.aName })}
                  />
                </td>
                <td class="muted">vs</td>
                <td>
                  <ProfileLink
                    steam={g.bSteam}
                    name={g.bName || '—'}
                    {nav}
                    cls={playerRoundCls(g.round, g.bSteam, g.bName)}
                    title={S.fill(S.combat.openProfileName, { name: g.bName })}
                  />
                </td>
                <td class="num" title={ENG_DIST_DEF}>{g.distance ? Math.round(g.distance) : '—'}</td>
              </tr>
            {:else}
              <tr>
                <td colspan="8" class="muted">
                  {error ? S.combat.engagementsUnavailable : S.combat.noEngagements}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel comb-sec">
      <h2>
        {S.combat.clutchesPrefix}<span class="chip provenance" title={S.combat.clutchTitle}>{S.combat.clutchChipLabel}</span>
      </h2>
      <!-- Outcome TOGGLES — the same independent-toggle shape as the
           Engagements card's kind chips (each flips its own boolean):
           won+lost = all rows, won-only = the default/historical list,
           lost-only = the lost rows, neither = the empty state below.
           The one divergence: the Engagements toggles treat ALL OFF as
           NO FILTER (every row), never an empty card. Local $state only
           — never route-query state (retention ruling pending). -->
      <div class="comb-kinds" role="group" aria-label={S.combat.filterClutchesLabel}>
        <button
          class="btn small comb-kind"
          class:active={clutchWon}
          aria-pressed={clutchWon}
          onclick={() => (clutchWon = !clutchWon)}
        >{S.combat.wonToggle}</button>
        <button
          class="btn small comb-kind"
          class:active={clutchLost}
          aria-pressed={clutchLost}
          onclick={() => (clutchLost = !clutchLost)}
        >{S.combat.lostToggle}</button>
      </div>
      {#if clutches.length === 0 && !error}
        <p class="muted" role="status">{S.combat.noClutches}</p>
      {:else if shownClutches.length === 0}
        <p class="muted" role="status">{clutchEmptyText}</p>
      {:else}
        <div class="table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th scope="col"><span class="sr-only">{S.combat.thReplay}</span></th>
                <th scope="col" class="num">{S.combat.thRound}</th>
                <th scope="col">{S.combat.thSize}</th>
                <th scope="col">{S.combat.thPlayer}</th>
                <th scope="col">{S.combat.thOutcome}</th>
                <th scope="col">{S.combat.thBomb}</th>
                <th scope="col" class="num def" title={S.combat.hpTitle}>{S.combat.thHpLeft}</th>
              </tr>
            </thead>
            <tbody>
              {#each shownClutches as c (c.id)}
                <tr>
                  <td>
                    {#if c.replayAnchorTick > 0}
                      <!-- Row ▶ follows the CLUTCH's solo (the row actor);
                           the loop is the KILL-span at the loop length (clutchLoop). -->
                      <EventPlay
                        tick={c.replayAnchorTick}
                        title={c.steamId
                          ? `Watch this clutch — follow ${c.name || c.steamId}`
                          : S.combat.watchClutch}
                        label={c.steamId
                          ? `Watch the clutch in round ${c.round} — follow ${c.name || c.steamId}`
                          : `Watch the clutch in round ${c.round} in the replay`}
                        onclick={() => replay(c.replayAnchorTick, clutchLoop(c), c.steamId)}
                      />
                    {/if}
                  </td>
                  <!-- Same ruling as the engagement row: the Round cell is
                       the bare round number under the RD heading, never a
                       second play button. -->
                  <td class="num">{c.round}</td>
                  <td><strong>1v{c.size}</strong></td>
                  <td>
                    <ProfileLink
                      steam={c.steamId}
                      name={c.name || '—'}
                      {nav}
                      cls={playerRoundCls(c.round, c.steamId, c.name)}
                      title={S.combat.openPlayerProfile}
                    />
                  </td>
                  <td>
                    <span class="chip status {c.won ? 'ok' : 'bad'}">{c.won ? 'won' : 'lost'}</span>
                  </td>
                  <td>
                    {#if c.bombState && c.bombState !== 'none'}
                      <span class="chip">{S.combat.bombPrefix}{c.bombState}</span>
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
</div>
