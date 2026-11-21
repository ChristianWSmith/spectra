<script>
  // The Match view's tab bar and its tab set (builtin, dogfood/04 §7; PLAN
  // C5c). Match.svelte keeps the hardcoded header, the warnings, the round
  // strip and the tab state (the URL owns the tab: routeTab and selectTab
  // live there). Everything from the tab bar down is this component: the bar,
  // and the content of the active tab. Each tab's content is a composer: a
  // panel source or a builtin component. A tab with one panel mounts that
  // panel directly, with no content wrapper.
  //
  // It renders no wrapper of its own, so the DOM under Match's `.view` is
  // the same as before (the frame it sits in is display: contents).
  //
  // Props (from Match.svelte): `tab` (the active tab), `ontab(t)` (the tab
  // bar's select), `nav` (the navigation the panels use), `panelProps` (the
  // shared panel props: the `back` path), `roundsProps` and `utilityProps`
  // (the Rounds and Utility panels' own props), and the Details facts that
  // are not panel reads: `match`, `voice`, `copyBusy` and `onfreecopy`.
  // The context (the match) arrives as the `context` prop of the frame.
  import * as S from '../../strings/index.js';
  import { MATCH_TABS } from '../../router.js';
  import { fmtBytes } from '../../fmt.js';
  import ComponentFrame from '../../components/ComponentFrame.svelte';
  import ChildFrame from '../../components/ChildFrame.svelte';
  import { MATCH_PANEL_IDS } from '../../matchpanels.js';
  import { ECON_PANEL_IDS } from '../../econpanels.js';
  import { UTIL_PANEL_IDS } from '../../utilpanels.js';
  import MatchHeatmaps from './Heatmaps.svelte';
  import MatchCombat from './Combat.svelte';
  import ReportsView from '../reports/ReportsView.svelte';
  import ExplorerView from '../explorer/ExplorerView.svelte';

  let {
    spectra,
    context = null,
    tab = 'Overview',
    ontab = () => {},
    nav = () => {},
    panelProps = {},
    roundsProps = {},
    utilityProps = {},
    match = null,
    voice = null,
    copyBusy = false,
    onfreecopy = () => {},
  } = $props();

  // The tab bar is the canonical list from the route table, so a deep
  // link can never point at a tab that does not exist.
  const TABS = MATCH_TABS;
</script>

<nav class="tabs" aria-label={S.match.matchSectionsAria}>
  {#each TABS as t (t)}
    <button class="tab" class:active={tab === t} onclick={() => ontab(t)}>
      {t}
    </button>
  {/each}
</nav>

{#if tab === 'Overview'}
  <ChildFrame name={MATCH_PANEL_IDS.overview} props={panelProps} {nav} />
  <ChildFrame name={MATCH_PANEL_IDS.rosters} props={panelProps} {nav} />
{:else if tab === 'Scoreboard'}
  <ChildFrame name={MATCH_PANEL_IDS.scoreboard} props={panelProps} {nav} />
{:else if tab === 'Rounds'}
  <ChildFrame name={MATCH_PANEL_IDS.rounds} props={roundsProps} {nav} />
{:else if tab === 'Economy'}
  <ChildFrame name={ECON_PANEL_IDS.economy} props={panelProps} {nav} />
{:else if tab === 'Utility'}
  <ChildFrame name={UTIL_PANEL_IDS.utility} props={utilityProps} {nav} />
{:else if tab === 'Heatmaps'}
  <ComponentFrame component={MatchHeatmaps} {context} {nav} />
{:else if tab === 'Combat'}
  <ComponentFrame component={MatchCombat} {context} {nav} />
{:else if tab === 'Reports'}
  <ComponentFrame component={ReportsView} {context} props={{ embedded: true }} {nav} />
{:else if tab === 'Details'}
  <!-- Details = technicals ONLY (owner ruling, 2026-11-15): the Key
       facts panel (server, tickrate, frames, size, import, parser,
       voice, warnings, source, demo copy) + Explorer's diagnostics
       (import details, advanced diagnostics), embedded and fixed to
       THIS match — the standalone Explorer's network-message census
       is Library copy, not this match's data, so it stays out of the
       tab. Gameplay-derived facts (the first blood) live on the
       Rounds tab. Map/Duration live in the match header. -->
  <!-- The stored facts are the details panel (matchpanels.js). Voice and
       the demo copy stay here: voice presence is not a component read
       (the query allowlist denies it), and the copy state comes from the
       filesystem on this read. -->
  <ChildFrame name={MATCH_PANEL_IDS.details} props={panelProps} {nav} />
  <section class="panel">
    <dl class="facts">
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
              onclick={onfreecopy}>{copyBusy ? S.match.freeing : S.match.freeCopy}</button
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
  <ComponentFrame component={ExplorerView} {context} props={{ embedded: true }} {nav} />
{/if}
