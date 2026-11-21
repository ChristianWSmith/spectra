<script>
  import * as S from '../strings/index.js';
  import { replayHash, entryLoopSpan } from '../nav.js';
  import { listedPlayers } from '../players.js';
  import { getMatch, getScoreboard, getRounds, getWarnings, getRoundClasses, getEconomy, getClutches, getEngagements, getUtility, getVoicePresence, getMatchSummary, evictDemoCopy, subscribeJobProgress, errText } from '../services.js';
  import { fmtDuration, fmtBytes, fmtDate, fmt1, fmtInt, fmtPatch } from '../fmt.js';
  import { teamNames, teamStartClass, playerSideClassAt } from '../teams.js';
  import { roundIndexLabel, separatorFlags, roundStartTick, roundEndTick } from '../rounds.js';
  import { winnerTeamKey } from '../sideparity.js';
  import { MATCH_TABS, MATCH_TAB_SECTIONS, matchTabSlug, buildHash } from '../router.js';
  import RoundStrip from '../components/RoundStrip.svelte';
  import ComponentFrame from '../components/ComponentFrame.svelte';
  import { OVERVIEW_SOURCE, ROSTERS_SOURCE, SCOREBOARD_SOURCE } from '../matchpanels.js';
  import Economy from './Economy.svelte';
  import Utility from './Utility.svelte';
  // The Heatmaps and Combat tabs are builtin components (PLAN C5-Heat-Combat):
  // the tab mounts its component through a frame with the match as context.
  import MatchHeatmaps from '../builtins/match/Heatmaps.svelte';
  import MatchCombat from '../builtins/match/Combat.svelte';
  // Details / Reports tabs embed the standalone views (embedded=true
  // fixes them to THIS match — no picker, no newest-match default).
  import Explorer from './Explorer.svelte';
  import Reports from './Reports.svelte';
  import StatusChip from '../components/StatusChip.svelte';
  import SortTh from '../components/SortTh.svelte';
  import StatCard from '../components/StatCard.svelte';
  import ProfileLink from '../components/ProfileLink.svelte';
  import WinnerCell from '../components/WinnerCell.svelte';
  import EventPlay from '../components/EventPlay.svelte';
  import HelpButton from '../components/HelpButton.svelte';
  import { seed, remember, matchKey } from '../viewstate.svelte.js';
  // Tier 1 of the loading ladder (PRODUCT.md "### Defaults"): the
  // replay's data bundle, warmed in the BACKGROUND from this screen.
  import { preloadReplay } from '../replay/preload.js';

  // routeTab: the deep-linked tab from App's route (#/match/:id/<slug> —
  // every tab is deep-linkable, see MATCH_TABS in lib/router.js); '' for
  // plain #/match/:id. Tabs are otherwise local state like every other
  // match tab — see selectTab for how the active tab mirrors itself in
  // the URL.
  // expandReplay: when App still holds a LIVE Replay instance for this
  // match (the mini-player dock — keepalive.js), it is THE expand path
  // back into it (App.expandReplay): "Watch replay" then returns to the
  // running instance (filter/loop/selection/playhead intact) instead of
  // minting a fresh entry hash. Null while no instance is alive → the
  // fresh-entry replayHash below, exactly as before.
  let { id = 0, nav = () => {}, routeTab = '', expandReplay = null, openDocs = () => {} } = $props();

  // The tab bar is the canonical list from the route table, so a deep
  // link can never point at a tab that does not exist.
  const TABS = MATCH_TABS;

  // The panels (matchpanels.js) read through this context (ruling 34): the
  // match, and nothing else. `back` is the tab the replay returns to.
  const panelContext = $derived({ matchId: id });
  const panelProps = $derived({ back: backPath() });

  // The header `?` targets the ACTIVE tab's guide section — the ONE
  // per-tab help button (Part 8's per-tab ruling): one button in the
  // view header, never one per tab (anti-spam criterion: primary
  // chrome only). MATCH_TAB_SECTIONS is the same table the lockstep
  // test pins, so the target and the documented coverage cannot drift.
  const helpSection = $derived(MATCH_TAB_SECTIONS[tab] || 'understanding-a-match');


  let match = $state(null);
  let summary = $state(null); // MatchSummary row (team names)
  let rounds = $state([]);
  let scoreboard = $state([]);
  let tab = $state('Overview');

  // Selection state (the Rounds-tab compare picks) restores per match through
  // the process-scoped registry (viewstate.svelte.js): the key carries the
  // match id (matchKey), so match A's picks never show in match B. The tab
  // stays URL-owned and is never registered.
  const selDefaults = () => ({ compareSel: [] });
  const selKey = $derived(matchKey('selection', id));
  const selInit = () => ({ ...seed(selKey, selDefaults()), key: selKey });
  const selSeed = selInit();
  let warnings = $state(null); // null = not loaded; then the page {messages,total}
  // Render cap for the warnings list: the DOM NEVER grows unbounded
  // whatever a fetch returns (independent of the store's fetch cap —
  // store.WarningsFetchLimit, same value — belt and braces), and the
  // cap line below states the TRUE remainder (total − shown): no silent
  // truncation, however long the parse's warning list is.
  const WARNINGS_RENDER_CAP = 200;
  // Warnings render directly (no header button): the panel is open by
  // default whenever the match has warnings, and the dismiss X hides it
  // for the rest of this mounted session.
  let warningsDismissed = $state(false);
  let error = $state('');
  // M4 header badges: voice presence + chat-decrypt key state.
  let voice = $state(null);

  // Analytics (M3): the Rounds tab's Class column left THIS view (W3a —
  // the table opens with its far-left watch column instead), so the
  // per-side buy-class read (store.GetEconomy, the canonical read the
  // Economy tab and RoundDetail's Economy card still share) is no longer
  // fetched here — only warmed through the analytics warm below.
  // The per-player KAST path (combatBySteam + its fetch + the combatError
  // panel) died with the dogfooding conversion (W2) — KAST% is a pinned
  // metric column now.
  // Rounds-tab compare picker: round numbers (max 4).
  let compareSel = $state(selSeed.compareSel);
  let selLastKey = selSeed.key;
  // Seed on the first run and on a match change; write through otherwise.
  let selSeeded = false;
  $effect(() => {
    const k = selKey;
    const cur = { compareSel };
    if (k !== selLastKey || !selSeeded) {
      // SEED — the first run after the pref lands, or another match
      // without a remount: apply this key's record (the pref-carrying
      // defaults when it has none) and do not write — the entry keeps
      // exactly what was applied, so the old match's values can never
      // land under the new key (the write-through re-arms on the next
      // selection change, which reads the re-seeded values).
      selLastKey = k;
      selSeeded = true;
      const s = seed(k, selDefaults());
      compareSel = s.compareSel;
      return;
    }
    remember(k, cur);
  });

  // Side-switch boundary per row (index-aligned with rounds): the
  // round-group separator gating from the canonical helper
  // (lib/rounds.js separatorFlags — cadence + counted-gating + trailing
  // suppression). Row i carries the boundary that follows row i-1 as its
  // `.split-before` class (public/style.css, the table twin of
  // RoundStrip's `.round-split`); counted-gating keeps a legacy
  // pre-reprocess negative row from shifting a line and the last row can
  // never carry a trailing one.
  const sepFlags = $derived(separatorFlags(rounds));


  // Match header + rounds + summary. Scoreboard has its own effect below
  // (sort changes must not re-trigger this one). The summary row is the
  // one-match GetMatchSummary getter (same JSON shape as a ListMatches
  // element) — never the whole library list for a single header lookup.
  $effect(() => {
    let live = true;
    Promise.all([
      getMatch(id),
      getRounds(id),
      getMatchSummary(id),
      getVoicePresence(id).catch(() => null),
    ])
      .then(([m, r, s, v]) => {
        if (!live) return;
        match = m;
        rounds = r || [];
        summary = s || null;
        voice = v;
        error = m ? '' : 'Match not found.';
      })
      .catch((e) => {
        if (live) error = errText(e);
      });
    return () => (live = false);
  });

  // Tier 1 of the loading ladder (PRODUCT.md "### Defaults"): warm the
  // replay bundle the MOMENT the match screen opens — before "Watch
  // replay" is ever clicked — so the replay usually resolves from
  // memory. Fire-and-forget: never awaited, never gates this view's
  // rendering (Replay's load() awaits the SAME memo, start-if-missing,
  // so a deep link straight to #/replay/:id keeps working). preloadReplay
  // skips the start while a library job is running — warming cached
  // reads mid-import is systematically wasted (preload.js documents the
  // bail-out; its flush listeners are the correctness net either way).
  // App reuses this view across id changes without remounting (see the
  // selection-key comment above), so the effect is keyed on id alone.
  $effect(() => {
    preloadReplay(id);
  });

  // Tier 1 of the loading ladder (PRODUCT.md "### Defaults"): warm the
  // per-match ANALYTICS set — this view's own KAST column and round chips
  // plus the Combat/Utility/Economy tabs' reads — the MOMENT the match
  // screen opens, so tab switches stop flashing "Loading…" / empty
  // tables. Fire-and-forget: never awaited, never gates rendering; the
  // reads below go through services' cachedRead wrappers, so this warm
  // shares ONE entry per (method, args) with this view's own effects and
  // with RoundDetail/CompareRounds.
  //
  // BAIL-OUT (mirror of preload.js:204-223 libraryJobsActive — READ-ONLY
  // reference, that module owns the replay bundle memo and pulls in the
  // whole preload engine, so the tiny flag is mirrored here): every
  // spectra:* data event clears services' readCache and spectra:job-progress
  // fires every ~100 ms, so warming cached reads mid-import is
  // systematically wasted. subscribeJobProgress hands the CURRENT snapshot
  // to the callback SYNCHRONOUSLY, so `running` is primed before the warm
  // decision below — whatever slips through the first ~100 ms window is
  // dropped by the flush listeners (the correctness net). The subscription
  // is scoped to this effect run and unsubscribed in its cleanup (a
  // component-lifetime registration would outlive every unmount). App
  // reuses this view across id changes without remounting (see the
  // selection-key comment above), so the effect is keyed on id alone —
  // and a falsy id has nothing to warm.
  $effect(() => {
    const mid = id;
    if (!(mid > 0)) return;
    let running = false;
    const off = subscribeJobProgress((snap) => {
      running = !!(snap && snap.size);
    });
    if (running) return off;
    void Promise.allSettled([
      getEconomy(mid),
      getRoundClasses(mid),
      getClutches(mid),
      getEngagements(mid, ''),
      getUtility(mid),
    ]);
    return off;
  });

  // Demo-copy state line (Details → Key facts): copyState is fs-derived
  // by Go on this read (copied / external / missing). Freeing re-reads the
  // header through the normal getter (the mutating wrapper invalidated the
  // read cache), so the state line re-derives instead of being guessed.
  let copyBusy = $state(false);

  async function onFreeCopy() {
    if (copyBusy || !match) return;
    copyBusy = true;
    try {
      await evictDemoCopy(match.id);
      match = await getMatch(id);
    } catch (e) {
      error = errText(e);
    } finally {
      copyBusy = false;
    }
  }

  // Warnings fetch — only when the match actually has warnings
  // (match.warningsCount > 0; a clean match renders no panel at all).
  // Re-runs when the match changes (id switch) and resets the list, so
  // the panel always shows this match's warnings while it is visible.
  $effect(() => {
    const n = match ? match.warningsCount : 0;
    if (!(n > 0)) return;
    let live = true;
    warnings = null;
    getWarnings(id)
      .then((w) => {
        if (live) warnings = w || { messages: [], total: 0 };
      })
      .catch((e) => {
        if (live) {
          warnings = { messages: [], total: 0 };
          error = errText(e);
        }
      });
    return () => (live = false);
  });

  // The rows the list actually renders (capped) and the honest
  // remainder the cap line states — both derived from the page, so a
  // caller passing MORE rows than the fetch contract allows still never
  // renders past WARNINGS_RENDER_CAP.
  const shownWarnings = $derived(
    warnings == null ? [] : (warnings.messages || []).slice(0, WARNINGS_RENDER_CAP),
  );
  const warningsHidden = $derived(
    warnings == null ? 0 : Math.max(0, (warnings.total || 0) - shownWarnings.length),
  );

  // Deep-linked tab from App's route (#/match/:id/<slug>): select the
  // tab whenever the route carries one — runs on mount before first
  // paint, so it also seeds the initial tab (no local prop read in the
  // $state initializer). When the tab bar clears the segment (selectTab →
  // plain #/match/:id for Overview) routeTab becomes '' and the local tab
  // state is left alone.
  $effect(() => {
    if (routeTab) tab = routeTab;
  });

  // Scoreboard fetch — ID-KEYED: ONE GetScoreboard call per match, in the
  // store's default order (kills DESC). The Scoreboard panel sorts its own
  // rows; this seed feeds the Rounds tab (team names and sides).
  $effect(() => {
    id;
    let live = true;
    getScoreboard(id, 'kills', true)
      .then((sb) => {
        // The ONE place this view's roster rows enter: listedPlayers
        // (lib/players.js — the canonical client-side bot filter; the
        // store already filters GetScoreboard, this is its twin) covers
        // every derivation below — the Rounds tab's team names and sides,
        // the team_<player> names and the per-round side lookups.
        if (live) scoreboard = listedPlayers(sb) || [];
      })
      .catch((e) => {
        if (live) error = errText(e);
      });
    return () => (live = false);
  });

  // The rows the Rounds tab reads (team names, sides). The scoreboard panel sorts its own.
  const viewRows = $derived(scoreboard);

  // The origin path for drill-down return trips (?back=…) — RoundDetail,
  // CompareRounds and Replay's Back button resolve it to this tab (plain
  // #/match/:id for Overview).
  function backPath() {
    return tab === 'Overview' ? `match/${id}` : `match/${id}/${matchTabSlug(tab)}`;
  }

  // Rounds-tab row ▶ — ROUND-level watch, byte-identical to Economy's
  // drill() and RoundDetail's "Watch round": the round's start tick as
  // ?tick=, its OWN start→end span as ?loop= (nav.entryLoopSpan — the
  // round IS the sequence, never an event-level pad) and THIS tab as the
  // ?back= origin. No landmark filter: outside the replay, buttons seek.
  // The row-click handler ignores button targets, so the row still opens
  // the round summary beside it.
  function watchRound(n) {
    const start = roundStartTick(rounds, n);
    // An unknown end stamps NO loop rather than a guessed bound —
    // entryLoopSpan yields undefined and buildHash drops it.
    const end = roundEndTick(rounds, n);
    nav(replayHash(id, {}, { tick: start, loop: entryLoopSpan(start, end), back: backPath() }));
  }

  // Player entry → THE event browser with the camera on that player. The
  // Overview cards, rosters and scoreboard panels open the replay themselves
  // (they follow the player the row or card names). back + follow are
  // navigation context, NOT a landmark filter.
  function openReplay() {
    // Keep-alive expand: the dock's one canonical path (same function the
    // mini-panel's click uses) — replayHash() below is only for a FRESH
    // entry (no instance alive), where the entry query is the point.
    if (expandReplay) {
      expandReplay();
      return;
    }
    nav(replayHash(id, {}, { back: backPath() }));
  }

  // SteamID64 guard — bots/short ids never match #/player/(\d{17}).
  // --- Rounds-tab compare picker (max 4) --------------------------------
  function toggleCompare(n) {
    if (compareSel.includes(n)) compareSel = compareSel.filter((x) => x !== n);
    else if (compareSel.length < 4) compareSel = [...compareSel, n];
  }

  // The compared rounds ride the URL — CompareRounds reads ?rounds= and
  // ?back=.
  function goCompare() {
    nav(
      buildHash(`/compare/${id}`, {
        rounds: compareSel.join(','),
        back: backPath(),
      }),
    );
  }

  // Tab switch: the active tab mirrors itself in the URL so every tab is
  // deep-linkable (#/match/:id/<slug>, slugs from MATCH_TABS in
  // lib/router.js). The default Overview tab keeps the plain #/match/:id
  // form (that is the URL-cleanup case — plain parses back to Overview),
  // and writing the segment always produces a hashchange, so drill-downs
  // that target another tab (nav('/match/:id/economy')) are never a
  // no-op while a different tab is visible. The hashchange re-parses to
  // the same route.name, so this view never remounts — only routeTab
  // changes, which the effect above applies.
  function selectTab(t) {
    tab = t;
    nav(t === 'Overview' ? `/match/${id}` : `/match/${id}/${matchTabSlug(t)}`);
  }

  // Team display names for the scoreline header and the roster headings:
  // the demo's clan names when the extract recorded them, else a
  // player-derived `team_<player>` name per side (see lib/teams.js).
  // These label the TEAMS (final sides) — never the sides themselves.
  const teams = $derived(
    teamNames({
      ctName: summary?.ctName || '',
      tName: summary?.tName || '',
      players: viewRows,
    }),
  );

  // Winner cell label for ONE round row: the TEAM that won it, resolved
  // by the canonical round-number parity (sideparity.winnerTeamKey) and
  // looked up in `teams` (keyed by final side). A side never names a
  // team past the halftime switch. Unknown (no winner side, round not
  // loaded) → '' so WinnerCell falls back to the bare side chip — never
  // a guessed name.
  function winnerName(r) {
    const key = winnerTeamKey(rounds, match?.sideSwitches || 0, r.number, r.winner);
    return key ? teams[key] : '';
  }

  function teamCls(finalSide) {
    return teamStartClass(finalSide, match?.sideSwitches || 0);
  }

  // Per-round SIDE color for a NAME carried as steam id + display name
  // (round MVP / first-blood rows): the side that player had IN THAT
  // round, resolved through lib/teams.js playerSideClassAt (scoreboard
  // lookup by id, then exact name, then the round's era) — not the
  // team's start side, which is what the aggregate surfaces above use.
  // Unresolved player → '' (never a guessed color).
  function playerRoundCls(roundNumber, steamId, name) {
    return playerSideClassAt(
      viewRows,
      match?.sideSwitches || 0,
      rounds,
      roundNumber,
      steamId,
      name,
    );
  }

</script>

<div class="view">
  {#if error}
    <!-- In-place dismissal: the ✕ clears the state variable itself (the
         id-keyed effect below re-arms it on the next match load). -->
    <p class="error" role="alert">
      {error}
      <button class="btn small" aria-label={S.match.dismissError} onclick={() => (error = '')}>
        <span class="codicon codicon-close"></span>
      </button>
    </p>
  {/if}

  {#if match}
    <header class="view-header match-header">
      <div>
        <h1>
          <span class={teamCls('ct')}>{teams.ct}</span>
          <span class="score">{match.scoreCT}–{match.scoreT}</span>
          <span class={teamCls('t')}>{teams.t}</span>
        </h1>
        <!-- The view's primary action: the FIRST cell of the meta line
             below the team names/scoreline — far LEFT, with the line's
             details following to its right (the component-scoped rule at
             the end of this file zeroes the global .match-replay
             auto-margin that used to park it on the right). It carries
             the play codicon and a size bump (.match-replay), so it
             still reads as the primary action without costing a line of
             its own. It launches at NO tick — a plain fresh entry (or the
             keep-alive expand), via openReplay below. Tickrate, voice
             presence and parser version live in the Details tab (Key
             facts); only the encrypted-chat key state stays up here. -->
        <p class="muted match-sub">
          <button
            class="btn primary match-replay"
            title={expandReplay
              ? S.match.replayReturnTitle
              : S.match.replayWatchTitle}
            onclick={openReplay}
          >
            <span class="codicon codicon-play" aria-hidden="true"></span> {S.match.watchReplay}
          </button>
          {match.map || '—'}
          · {fmtDuration(match.playbackTimeS)}
          {S.match.patchLabel} {fmtPatch(match.patchVersion)}
          · <StatusChip status={match.status || 'ready'} title={match.error || ''} />
          {#if voice && !voice.keyFound && (match.encryptedMessages || 0) > 0}
            <span
              class="chip voice-badge idle"
              title={S.match.encryptedChatTitle}
              ><span class="codicon codicon-lock"></span></span
            >
          {/if}
        </p>
      </div>
      <!-- The view's help affordance (HelpButton.svelte): ONE `?` in
           the header, right of the .spacer, targeting the section of
           the tab you are on (helpSection above — per-tab, one button). -->
      <div class="spacer"></div>
      <HelpButton section={helpSection} {openDocs} />
    </header>

    <!-- Warnings: no button — the panel is present iff the match has
         warnings (fetched on load), open until dismissed. -->
    {#if match.warningsCount > 0 && !warningsDismissed}
      <div class="panel warnings-panel">
        <div class="row-between">
          <h2>{S.match.importWarnings}</h2>
          <button class="btn small" aria-label={S.match.dismissWarnings} onclick={() => (warningsDismissed = true)}>
            <span class="codicon codicon-close"></span>
          </button>
        </div>
        {#if warnings == null}
          <p class="muted" role="status"><StatusChip block detail="Loading…" /></p>
        {:else if warnings.messages.length === 0}
          <p class="muted" role="status">{S.match.warningsNone}</p>
        {:else}
          <ul class="warning-list">
            {#each shownWarnings as w, i (i)}
              <li>{w}</li>
            {/each}
          </ul>
          {#if warningsHidden > 0}
            <p class="muted">{S.fill(S.match.warningsMore, { n: fmtInt(warningsHidden) })}</p>
          {/if}
        {/if}
      </div>
    {/if}

    <RoundStrip
      {rounds}
      matchId={id}
      teamAbove={teams.ct}
      teamBelow={teams.t}
      sideSwitches={match.sideSwitches || 0}
      back={backPath()}
      {nav}
    />

    <nav class="tabs" aria-label={S.match.matchSectionsAria}>
      {#each TABS as t (t)}
        <button class="tab" class:active={tab === t} onclick={() => selectTab(t)}>
          {t}
        </button>
      {/each}
    </nav>

    {#if tab === 'Overview'}
      <ComponentFrame source={OVERVIEW_SOURCE} context={panelContext} props={panelProps} {nav} />
      <ComponentFrame source={ROSTERS_SOURCE} context={panelContext} props={panelProps} {nav} />
    {:else if tab === 'Scoreboard'}
      <ComponentFrame source={SCOREBOARD_SOURCE} context={panelContext} props={panelProps} {nav} />
    {:else if tab === 'Rounds'}
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <!-- Far-left watch column (W3a): the canonical ghost ▶ cell
                   (EventPlay) — same sr-only header idiom RoundDetail's
                   kill/bomb tables use. -->
              <th scope="col"><span class="sr-only">{S.match.colWatch}</span></th>
              <th
                scope="col"
                class="num cmp-cmp-col"
                title={S.match.compareSelectTitle}
              >{S.match.colCmp}</th>
              <th scope="col" class="num">RD</th>
              <th scope="col">{S.match.colWinner}</th>
              <th scope="col">{S.match.colReason}</th>
              <th scope="col" class="num">{S.match.colDuration}</th>
              <th scope="col">{S.match.colSite}</th>
              <th scope="col">{S.match.colMvp}</th>
              <th scope="col">{S.match.firstBloodLabel}</th>
              <th scope="col" class="num">{S.match.colKills}</th>
            </tr>
          </thead>
          <tbody>
            {#each rounds as r, ri (r.number)}
              <tr
                class="clickable"
                class:split-before={ri > 0 && sepFlags[ri - 1]}
                onclick={(e) => {
                  if (e.target instanceof Element && e.target.closest('input, button, a'))
                    return;
                  nav(buildHash(`/match/${id}/round/${r.number}`, { back: backPath() }));
                }}
                onkeydown={(e) =>
                  e.key === 'Enter' && nav(buildHash(`/match/${id}/round/${r.number}`, { back: backPath() }))}
                tabindex="0"
              >
                <td>
                  <!-- The row's own ▶ — ROUND-level stamping (watchRound
                       above); the row handler ignores button targets, so
                       the row still opens the round summary. -->
                  <EventPlay
                    tick={roundStartTick(rounds, r.number)}
                    title={S.fill(S.match.watchRoundTitle, { round: r.number })}
                    label={S.fill(S.match.watchRoundAria, { round: r.number })}
                    onclick={() => watchRound(r.number)}
                  />
                </td>
                <td class="num cmp-cmp-col" onclick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    class="cmp-cb"
                    checked={compareSel.includes(r.number)}
                    disabled={compareSel.length >= 4 && !compareSel.includes(r.number)}
                    aria-label={S.fill(S.match.compareRoundAria, { round: roundIndexLabel(r) })}
                    onchange={() => toggleCompare(r.number)}
                  />
                </td>
                <td class="num">{roundIndexLabel(r)}</td>
                <td>
                  <WinnerCell winner={r.winner} name={winnerName(r)} />
                </td>
                <td>{r.reason || '—'}</td>
                <td class="num">{fmtDuration(r.durationS)}</td>
                <td>{r.bombSite || '—'}</td>
                <td>
                  {#if r.mvpName}
                    <ProfileLink
                      steam={r.mvp}
                      name={r.mvpName}
                      {nav}
                      cls={playerRoundCls(r.number, r.mvp, r.mvpName)}
                      title={S.fill(S.match.openProfile, { name: r.mvpName })}
                    />
                  {:else}
                    —
                  {/if}
                </td>
                <td>
                  {#if r.firstKillName && r.firstDeathName}
                    <ProfileLink
                      steam={r.firstKillSteam}
                      name={r.firstKillName}
                      {nav}
                      cls={playerRoundCls(r.number, r.firstKillSteam, r.firstKillName)}
                      title={S.fill(S.match.openProfile, { name: r.firstKillName })}
                    />
                    {S.match.killedVerb}
                    <ProfileLink
                      steam={r.firstDeathSteam}
                      name={r.firstDeathName}
                      {nav}
                      cls={playerRoundCls(r.number, r.firstDeathSteam, r.firstDeathName)}
                      title={S.fill(S.match.openProfile, { name: r.firstDeathName })}
                    />
                  {:else}
                    —
                  {/if}
                </td>
                <td class="num">{r.kills}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if compareSel.length > 0}
        <p class="cmp-hint">
          {S.fill(S.match.roundsSelected, { n: compareSel.length })}
        </p>
      {/if}
      {#if compareSel.length >= 2}
        <button class="btn primary cmp-float" onclick={goCompare}>
          {S.fill(S.match.compareBtn, { n: compareSel.length })} <span class="codicon codicon-chevron-right"></span>
        </button>
      {/if}
    {:else if tab === 'Economy'}
      <Economy {id} {nav} />
    {:else if tab === 'Utility'}
      <Utility {id} />
    {:else if tab === 'Heatmaps'}
      <ComponentFrame component={MatchHeatmaps} context={panelContext} {nav} />
    {:else if tab === 'Combat'}
      <ComponentFrame component={MatchCombat} context={panelContext} {nav} />
    {:else if tab === 'Reports'}
      <Reports embedded routeId={id} {nav} />
    {:else if tab === 'Details'}
      <!-- Details = technicals ONLY (owner ruling, 2026-11-15): the Key
           facts panel (server, tickrate, frames, size, import, parser,
           voice, warnings, source, demo copy) + Explorer's diagnostics
           (import details, advanced diagnostics), embedded and fixed to
           THIS match — the standalone Explorer's network-message census
           is Library copy, not this match's data, so it stays out of the
           tab. Gameplay-derived facts (the first blood) live on the
           Rounds tab. Map/Duration live in the match header. -->
      <section class="panel">
        <h2>{S.match.keyFacts}</h2>
        <dl class="facts">
          <div><dt>{S.match.factServer}</dt><dd>{match.serverName || '—'}</dd></div>
          <div><dt>{S.match.factTickrate}</dt><dd>{fmt1(match.tickRate)} Hz</dd></div>
          <div><dt>{S.match.factFrames}</dt><dd class="num">{fmtInt(match.frames)}</dd></div>
          <div><dt>{S.match.factSize}</dt><dd>{fmtBytes(match.size)}</dd></div>
          <div><dt>{S.match.factImported}</dt><dd>{fmtDate(match.extractedAt)}</dd></div>
          <div><dt>{S.match.factParser}</dt><dd class="mono">{match.parserVersion || '—'}</dd></div>
          <div>
            <dt>{S.match.factVoice}</dt>
            <dd>
              {#if !voice}
                <span class="muted">—</span>
              {:else if voice.hasVoice}
                <span
                  class="chip voice-badge busy"
                  title={S.fill(S.match.voiceRecordedTitle, { n: voice.playerCount })}
                  ><span class="codicon codicon-unmute"></span>
                  {S.fill(S.match.voiceRecordedBadge, { n: voice.playerCount })}</span
                >
              {:else}
                <span
                  class="chip voice-badge idle"
                  title={S.match.voiceNoneTitle}
                  >{S.match.voiceNoneBadge}</span
                >
              {/if}
            </dd>
          </div>
          <div><dt>{S.match.factWarnings}</dt><dd>{match.warningsCount}</dd></div>
          <div class="fact-wide"><dt>{S.match.factSource}</dt><dd class="mono">{match.path}</dd></div>
          <!-- State line under Source: which demo file Re-parse would read
               right now (copyState is fs-derived by Go on this read —
               store never fills it). -->
          <div class="fact-wide">
            <dt>{S.match.factDemoCopy}</dt>
            <dd>
              {#if match.copyState === 'copied'}
                <span>{S.match.copyPrefix} {fmtBytes(match.size)}</span>
                <button
                  class="btn small"
                  disabled={copyBusy}
                  title={S.match.freeCopyTitle}
                  onclick={onFreeCopy}>{copyBusy ? S.match.freeing : S.match.freeCopy}</button
                >
              {:else if match.copyState === 'external'}
                <span class="muted">{S.match.copyExternal}</span>
              {:else if match.copyState === 'missing'}
                <span class="muted">{S.match.copyMissing}</span>
              {:else}
                <!-- Unstamped (never in production — Go always derives one
                     of the three states): a placeholder, never a claim. -->
                <span class="muted">—</span>
              {/if}
            </dd>
          </div>
        </dl>
      </section>
      <Explorer embedded routeId={id} {nav} />
    {/if}
  {:else if !error}
    <p class="muted" role="status"><StatusChip block detail="Loading…" /></p>
  {/if}
</div>

<style>
  /* Watch replay sits at the FAR LEFT of the .match-sub meta row (its
     first flex child — the details follow to its right). The global
     .match-replay rule in public/style.css carries `margin-left: auto`,
     which parks it at the RIGHT end of that flex row; this component-
     scoped override zeroes it for THIS row only instead of editing the
     shared rule (public/style.css stays the design worker's file, and
     the right-parked layout remains available to any other host).
     Component CSS is injected after the global sheet and this selector
     is more specific, so it wins. */
  .match-sub .match-replay {
    margin-left: 0;
  }
</style>
