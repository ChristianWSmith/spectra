<script>
  // The Match view's tab bar and its tab set. Match.svelte keeps the hardcoded header, the warnings, the round
  // strip and the URL, which owns the active tab (routeTab and selectTab live
  // there). Everything from the tab bar down is this component: the bar, and
  // the content of the active tab. Each tab's content is a composer: a panel
  // source or a builtin component. A tab with one panel mounts that panel
  // directly, with no content wrapper.
  //
  // The data is this component's own: the match is the `context` the frame
  // mounts it with, and the panels read their facts through that context. The
  // per-match view state (the Utility filters) and the loop length are read
  // here, not handed in by the host.
  //
  // It renders no wrapper of its own, so the DOM under Match's `.view` is
  // the same as before (the frame it sits in is display: contents).
  //
  // Props: `context` (the match), `nav` (the navigation the panels use), and
  // the active tab with its select, `tab` and `ontab`, which only the URL can
  // supply (see the note at `tab` below).
  import { onMount } from 'svelte';
  import * as S from '../../strings/index.js';
  import { MATCH_TABS, matchTabSlug } from '../../router.js';
  import { getPref } from '../../services.js';
  import { LOOP_SECS_DEFAULT, prefLoopSecs } from '../../nav.js';
  import { seed, remember, matchKey } from '../../viewstate.svelte.js';

  let {
    spectra,
    context = null,
    // The active tab is the URL's (#/match/:id/<slug>), and the view registry
    // never holds it (viewstate.svelte.js), so the host passes it with its
    // select. Defaults to the first tab: with no host, the tab bar and the
    // Overview panels still render from the context alone.
    tab = MATCH_TABS[0],
    ontab = () => {},
    nav = () => {},
    // The round the URL asks open on the Rounds tab (?round=N).
    expandRound = null,
    // A warm mount (lib/warm.js): every tab mounts at once, its inactive panes laid out hidden at the real
    // width, so each panel loads and measures before the user opens its tab.
    warm = false,
  } = $props();

  // The tab bar is the canonical list from the route table, so a deep
  // link can never point at a tab that does not exist.
  const TABS = MATCH_TABS;

  const matchId = $derived(context ? context.matchId : null);
  // The origin path the drill-downs return to (?back=…): the replay, the round
  // and compare pages resolve it to this tab (plain match/:id for Overview).
  // The first tab of the route table is the Overview, the one plain match/:id route.
  const backPath = $derived(tab === MATCH_TABS[0] ? `match/${matchId}` : `match/${matchId}/${matchTabSlug(tab)}`);
  const panelProps = $derived({ back: backPath });

  // The Utility builtin's loop length, read once: a builtin's preference read
  // is the one plain pref the tabs share (ruling 33), and this match's filters
  // (kind, thrower, round) are kept in the view registry under the match.
  let loopSecs = $state(LOOP_SECS_DEFAULT);
  onMount(() => {
    getPref('loop_secs')
      .then((v) => (loopSecs = prefLoopSecs(v)))
      .catch(() => {
        /* keep the default */
      });
  });
  // The tab names, by key, from the canonical list (router MATCH_TABS), so the
  // markup never compares against a bare string.
  const TAB = Object.freeze({
    overview: MATCH_TABS[0], scoreboard: MATCH_TABS[1], rounds: MATCH_TABS[2],
    economy: MATCH_TABS[3], utility: MATCH_TABS[4], combat: MATCH_TABS[5],
    heatmaps: MATCH_TABS[6], reports: MATCH_TABS[7], details: MATCH_TABS[8],
  });
  // A pane is laid out (display: contents) only while its tab is active.
  const paneDisplay = (t) => (t === tab ? 'contents' : 'none');
  // Tabs that have been shown at least once stay mounted (see the panes below).
  let seen = $state({});
  // A warm mount has every tab seen from the start.
  $effect(() => {
    if (warm) seen = Object.fromEntries(MATCH_TABS.map((t) => [t, true]));
  });
  $effect(() => {
    if (!seen[tab]) seen = { ...seen, [tab]: true };
  });
  // The active tab mounts at once; the others mount on their first showing.
  const isShown = (t) => t === tab || !!seen[t];
  const roundsProps = $derived({ back: backPath, loopSecs, expandRound });
  const utilityProps = $derived({
    ...panelProps,
    loopSecs,
    filters: seed(matchKey('utility', matchId), { kindF: [], throwerF: '', roundSel: '' }),
    onfilters: (f) => remember(matchKey('utility', matchId), f),
  });
</script>

<nav class="tabs" aria-label={S.match.matchSectionsAria}>
  {#each TABS as t (t)}
    <button class="tab" class:active={tab === t} onclick={() => ontab(t)}>
      {t}
    </button>
  {/each}
</nav>

<!-- Each tab's panes mount the first time the tab is shown, then stay mounted
     (hidden while another tab is active), so switching tabs does not
     reload their data or lose their state. -->
{#if isShown(TAB.overview)}
  <div class="tab-pane" class:warm-hidden={warm && tab !== TAB.overview} style:display={warm && tab !== TAB.overview ? null : paneDisplay(TAB.overview)}>
    <spectra.Child name="match-overview" props={panelProps} />
    <spectra.Child name="match-rosters" props={panelProps} />
  </div>
{/if}
{#if isShown(TAB.scoreboard)}
  <div class="tab-pane" class:warm-hidden={warm && tab !== TAB.scoreboard} style:display={warm && tab !== TAB.scoreboard ? null : paneDisplay(TAB.scoreboard)}>
    <spectra.Child name="match-scoreboard" props={panelProps} />
  </div>
{/if}
{#if isShown(TAB.rounds)}
  <div class="tab-pane" class:warm-hidden={warm && tab !== TAB.rounds} style:display={warm && tab !== TAB.rounds ? null : paneDisplay(TAB.rounds)}>
    <spectra.Child name="match-rounds" props={roundsProps} />
  </div>
{/if}
{#if isShown(TAB.economy)}
  <div class="tab-pane" class:warm-hidden={warm && tab !== TAB.economy} style:display={warm && tab !== TAB.economy ? null : paneDisplay(TAB.economy)}>
    <spectra.Child name="match-economy" props={panelProps} />
  </div>
{/if}
{#if isShown(TAB.utility)}
  <div class="tab-pane" class:warm-hidden={warm && tab !== TAB.utility} style:display={warm && tab !== TAB.utility ? null : paneDisplay(TAB.utility)}>
    <spectra.Child name="match-utility" props={utilityProps} />
  </div>
{/if}
{#if isShown(TAB.heatmaps)}
  <div class="tab-pane" class:warm-hidden={warm && tab !== TAB.heatmaps} style:display={warm && tab !== TAB.heatmaps ? null : paneDisplay(TAB.heatmaps)}>
    <spectra.Child name="match-heatmaps" />
  </div>
{/if}
{#if isShown(TAB.combat)}
  <div class="tab-pane" class:warm-hidden={warm && tab !== TAB.combat} style:display={warm && tab !== TAB.combat ? null : paneDisplay(TAB.combat)}>
    <spectra.Child name="match-combat" />
  </div>
{/if}
{#if isShown(TAB.reports)}
  <div class="tab-pane" class:warm-hidden={warm && tab !== TAB.reports} style:display={warm && tab !== TAB.reports ? null : paneDisplay(TAB.reports)}>
    <spectra.Child name="match-reports" props={{ embedded: true }} />
  </div>
{/if}
{#if isShown(TAB.details)}
  <!-- Details = technicals ONLY (owner ruling, 2026-11-15): the Key
       facts panel (server, tickrate, frames, size, import, parser,
       warnings, source), the voice and demo-copy facts, and Explorer's
       diagnostics (import details, advanced diagnostics), embedded and fixed
       to THIS match. Gameplay-derived facts (the first blood) live on the
       Rounds tab. Map/Duration live in the match header. -->
  <div class="tab-pane" class:warm-hidden={warm && tab !== TAB.details} style:display={warm && tab !== TAB.details ? null : paneDisplay(TAB.details)}>
    <spectra.Child name="match-details" />
  </div>
{/if}
