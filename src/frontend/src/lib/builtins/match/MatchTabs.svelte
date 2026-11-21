<script>
  // The Match view's tab bar and its tab set (builtin, dogfood/04 §7; PLAN
  // C5c). Match.svelte keeps the hardcoded header, the warnings, the round
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
  import { MATCH_PANEL_IDS } from '../../matchpanels.js';
  import { ECON_PANEL_IDS } from '../../econpanels.js';
  import { UTIL_PANEL_IDS } from '../../utilpanels.js';
  import { getPref } from '../../services.js';
  import { LOOP_SECS_DEFAULT, prefLoopSecs } from '../../nav.js';
  import { seed, remember, matchKey } from '../../viewstate.svelte.js';

  let {
    spectra,
    context = null,
    // The active tab is the URL's (#/match/:id/<slug>), and the view registry
    // never holds it (viewstate.svelte.js), so the host passes it with its
    // select. Defaults to Overview: with no host, the tab bar and the
    // Overview panels still render from the context alone.
    tab = 'Overview',
    ontab = () => {},
    nav = () => {},
  } = $props();

  // The tab bar is the canonical list from the route table, so a deep
  // link can never point at a tab that does not exist.
  const TABS = MATCH_TABS;

  const matchId = $derived(context ? context.matchId : null);
  // The origin path the drill-downs return to (?back=…): the replay, the round
  // and compare pages resolve it to this tab (plain match/:id for Overview).
  const backPath = $derived(tab === 'Overview' ? `match/${matchId}` : `match/${matchId}/${matchTabSlug(tab)}`);
  const panelProps = $derived({ back: backPath });
  const roundsProps = $derived({ back: backPath });

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
  const utilityProps = $derived({
    ...panelProps,
    loopSecs,
    filters: seed(matchKey('utility', matchId), { kindF: '', throwerF: '', roundSel: '' }),
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

{#if tab === 'Overview'}
  <spectra.Child name={MATCH_PANEL_IDS.overview} props={panelProps} />
  <spectra.Child name={MATCH_PANEL_IDS.rosters} props={panelProps} />
{:else if tab === 'Scoreboard'}
  <spectra.Child name={MATCH_PANEL_IDS.scoreboard} props={panelProps} />
{:else if tab === 'Rounds'}
  <spectra.Child name={MATCH_PANEL_IDS.rounds} props={roundsProps} />
{:else if tab === 'Economy'}
  <spectra.Child name={ECON_PANEL_IDS.economy} props={panelProps} />
{:else if tab === 'Utility'}
  <spectra.Child name={UTIL_PANEL_IDS.utility} props={utilityProps} />
{:else if tab === 'Heatmaps'}
  <spectra.Child name="builtin-match-heatmaps" />
{:else if tab === 'Combat'}
  <spectra.Child name="builtin-match-combat" />
{:else if tab === 'Reports'}
  <spectra.Child name="builtin-reports" props={{ embedded: true }} />
{:else if tab === 'Details'}
  <!-- Details = technicals ONLY (owner ruling, 2026-11-15): the Key
       facts panel (server, tickrate, frames, size, import, parser,
       warnings, source), the voice and demo-copy facts, and Explorer's
       diagnostics (import details, advanced diagnostics), embedded and fixed
       to THIS match — the standalone Explorer's network-message census is
       Library copy, not this match's data, so it stays out of the tab.
       Gameplay-derived facts (the first blood) live on the Rounds tab.
       Map/Duration live in the match header. -->
  <spectra.Child name={MATCH_PANEL_IDS.details} />
  <spectra.Child name={MATCH_PANEL_IDS.facts} />
  <spectra.Child name="builtin-explorer" props={{ embedded: true }} />
{/if}
