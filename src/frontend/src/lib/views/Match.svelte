<script>
  import { createLoadState } from '../loadstate.svelte.js';
  import LoadBox from '../components/LoadBox.svelte';
  import * as S from '../strings/index.js';
  import { replayHash } from '../nav.js';
  import { listedPlayers } from '../players.js';
  import { getMatch, getScoreboard, getRounds, getWarnings, getRoundClasses, getClutches, getKillTags, getVoicePresence, getMatchSummary, subscribeJobProgress, errText } from '../services.js';
  import { fmtDuration, fmtInt, fmtPatch } from '../fmt.js';
  import { teamNames, teamStartClass } from '../teams.js';
  import { MATCH_TAB_SECTIONS, matchTabSlug } from '../router.js';
  import RoundStrip from '../components/RoundStrip.svelte';
  import ComponentFrame from '../components/ComponentFrame.svelte';
  import SurfaceView from '../components/SurfaceView.svelte';
  // The tab bar and the tab set are one builtin component:
  // Match.svelte keeps the header, the warnings, the round strip and the
  // tab state; the tabs and their content are MatchTabs.
  import MatchTabs from '../builtins/match/MatchTabs.svelte';
  import StatusChip from '../components/StatusChip.svelte';
  import SortTh from '../components/SortTh.svelte';
  import StatCard from '../components/StatCard.svelte';
  import HelpButton from '../components/HelpButton.svelte';
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
  // routeRound: the round the URL asks open on the Rounds tab (?round=N, from the economy and compare links).
  let { id = 0, nav = () => {}, routeTab = '', routeRound = null, expandReplay = null, openDocs = () => {}, warm = false } = $props();

  // The tab set and its panels read through this context (ruling 34): the
  // match, and nothing else. The tab set reads its own data from it, so the
  // view passes nothing else but the active tab and its select.
  const panelContext = $derived({ matchId: id });
  const tabsProps = $derived({ tab, ontab: selectTab, expandRound: routeRound, warm });

  // The header `?` targets the ACTIVE tab's guide section — the ONE
  // per-tab help button (Part 8's per-tab ruling): one button in the
  // view header, never one per tab (anti-spam criterion: primary
  // chrome only). MATCH_TAB_SECTIONS is the same table the lockstep
  // test pins, so the target and the documented coverage cannot drift.
  const helpSection = $derived(MATCH_TAB_SECTIONS[tab] || 'understanding-a-match');


  let match = $state(null);
  const loadState = createLoadState();
  let summary = $state(null); // MatchSummary row (team names)
  let rounds = $state([]);
  let scoreboard = $state([]);
  let tab = $state('Overview');

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
  let voiceError = $state('');

  // Analytics (M3): the Rounds tab's Class column left THIS view (W3a —
  // the table opens with its far-left watch column instead), so the
  // per-side buy-class read (store.GetEconomy, the canonical read the
  // Economy tab and RoundDetail's Economy card still share) is no longer
  // fetched here — only warmed through the analytics warm below.
  // The per-player KAST path (combatBySteam + its fetch + the combatError
  // panel) died with the dogfooding conversion (W2) — KAST% is a pinned
  // metric column now.
  // Match header + rounds + summary. Scoreboard has its own effect below
  // (sort changes must not re-trigger this one). The summary row is the
  // one-match GetMatchSummary getter (same JSON shape as a ListMatches
  // element) — never the whole library list for a single header lookup.
  $effect(() => {
    let live = true;
    // The match is one load keyed by its id: the first read is busy (the body shows the shell's spinner); a
    // refresh of the same match keeps the content on screen.
    loadState
      .track(
        Promise.all([
          getMatch(id),
          getRounds(id),
          getMatchSummary(id),
          getVoicePresence(id).catch((e) => {
            voiceError = errText(e);
            return null;
          }),
        ]),
        String(id),
        ([m, r, s, v]) => {
          if (!live) return;
          match = m;
          rounds = r || [];
          summary = s || null;
          voice = v;
          if (v) voiceError = '';
          error = m ? '' : 'Match not found.';
        },
      )
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
      getRoundClasses(mid),
      getClutches(mid),
      getKillTags(mid, ''),
    ]);
    return off;
  });

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
  // A new match (id change) opens on Overview unless the route names a tab, so
  // the previous match's tab never carries over. Tab clicks rewrite the route,
  // so this effect only runs on an id or route change.
  $effect(() => {
    void id;
    tab = routeTab || 'Overview';
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

  function teamCls(finalSide) {
    return teamStartClass(finalSide, match?.sideSwitches || 0);
  }

</script>

<LoadBox tag="div" class="view" busy={loadState.busy} key={loadState.key} name="view:match">
  {#if voiceError}
    <p class="error" role="alert">
      {voiceError}
      <button class="btn small ghost" aria-label={S.common.dismissErrorLine} title={S.common.dismissErrorLine} onclick={() => (voiceError = '')}><span class="codicon codicon-close" aria-hidden="true"></span></button>
    </p>
  {/if}
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
          <LoadBox tag="div" class="warn-hold" busy name="match-warnings" key=""></LoadBox>
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
      {nav}
    />

    <!-- The Match view's area below the header: the placed component(s) when
         the user has used one as their view, else the default tab set. -->
    <SurfaceView surface="match-view" context={panelContext} {nav}>
      {#snippet fallback()}
        <ComponentFrame
          component={MatchTabs}
          context={panelContext}
          props={tabsProps}
          {nav}
        />
      {/snippet}
    </SurfaceView>
  {/if}
</LoadBox>

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
