<script>
  import { onMount } from 'svelte';
  import { AppService } from '../bindings/github.com/ChristianWSmith/spectra';
  import Library from './lib/views/Library.svelte';
  import Match from './lib/views/Match.svelte';
  import RoundDetail from './lib/views/RoundDetail.svelte';
  import Replay from './lib/views/Replay.svelte';
  import Settings from './lib/views/Settings.svelte';
  import Builder from './lib/views/Builder.svelte';
  import SqlConsole from './lib/views/SqlConsole.svelte';
  import Explorer from './lib/views/Explorer.svelte';
  import Reports from './lib/views/Reports.svelte';
  import Profiles from './lib/views/Profiles.svelte';
  import CommandPalette from './lib/components/CommandPalette.svelte';
  import MapPackPrompt from './lib/components/MapPackPrompt.svelte';
  import PlayerProfile from './lib/views/PlayerProfile.svelte';
  import CompareRounds from './lib/views/CompareRounds.svelte';
  import { parseHash } from './lib/router.js';
  import { NAV_ACTIONS } from './lib/nav.js';

  // Hand-rolled hash router: the route table (parseHash) lives in
  // lib/router.js with its own tests; this component owns the hashchange
  // wiring and the view switch.
  let route = $state(parseHash(location.hash));
  // In-app origin for views that return "where you came from":
  // PlayerProfile's back button resolves it through profileBackTarget
  // (lib/nav.js). Recorded on every hashchange — the hash BEFORE the
  // current one — so it is empty until the first navigation.
  let originHash = $state('');
  let lastHash = location.hash;
  let mapPackPrompt = $state(null); // MapPackPrompt instance (bind:this)

  // Sidebar layout partitions the shared action list (lib/nav.js):
  // `bottom` entries (Settings) pin to the rail's foot as a gear; every
  // other action renders in the main icon list. Membership itself stays
  // in NAV_ACTIONS — the command palette renders the same list.
  const mainActions = NAV_ACTIONS.filter((a) => !a.bottom);
  const bottomActions = NAV_ACTIONS.filter((a) => a.bottom);

  onMount(() => {
    const onChange = () => {
      originHash = lastHash;
      lastHash = location.hash;
      route = parseHash(location.hash);
    };
    window.addEventListener('hashchange', onChange);

    // One-time CS2 radar-extraction prompt: detection + decision persist
    // in Go (MapPackPrompt decides whether to show; never throws).
    mapPackPrompt?.maybePrompt();

    // Report the window size to Go (debounced) whenever the user resizes,
    // so the next launch can restore it. See prefs.go on the Go side.
    let timer;
    const report = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        AppService.SaveWindowSize(window.innerWidth, window.innerHeight).catch(
          console.error,
        );
      }, 500);
    };
    window.addEventListener('resize', report);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('hashchange', onChange);
      window.removeEventListener('resize', report);
    };
  });

  function nav(hash) {
    location.hash = hash;
  }
</script>

<div class="shell">
  <nav class="sidebar" aria-label="Main">
    <!-- App mark: branding, not a nav action — it never takes the rail's
         hover/active treatment and is inert to the pointer (see
         .sidebar-mark), so it can never be mistaken for a button. The
         asset is the favicon (/wails.png): the same bracket mark as the
         window icon (build/appicon.png). -->
    <img class="sidebar-mark" src="/wails.png" alt="spectra" width="30" height="30" />
    <!-- One action list, shared with CommandPalette's Actions section
         (lib/nav.js NAV_ACTIONS) — membership, order, labels and icons
         live there; active(route) drives the highlight here. The button
         is icon-only: the label rides title/aria-label (hover tooltip). -->
    {#each mainActions as a (a.label)}
      <button
        class="nav-item"
        class:active={a.active(route)}
        type="button"
        title={a.label}
        aria-label={a.label}
        aria-current={a.active(route) ? 'page' : undefined}
        onclick={() => nav(a.hash)}
      >
        <span class="codicon {a.icon}" aria-hidden="true"></span>
      </button>
    {/each}
    <div class="spacer"></div>
    <!-- Pinned bottom entries (Settings) — same list, split by the
         `bottom` flag; see mainActions above. -->
    {#each bottomActions as a (a.label)}
      <button
        class="nav-item"
        class:active={a.active(route)}
        type="button"
        title={a.label}
        aria-label={a.label}
        aria-current={a.active(route) ? 'page' : undefined}
        onclick={() => nav(a.hash)}
      >
        <span class="codicon {a.icon}" aria-hidden="true"></span>
      </button>
    {/each}
  </nav>
  <main class="content">
    {#if route.name === 'library'}
      <Library {nav} query={route.query || {}} />
    {:else if route.name === 'match'}
      <Match id={route.id} routeTab={route.tab || ''} {nav} />
    {:else if route.name === 'round'}
      <RoundDetail id={route.id} round={route.round} query={route.query || {}} {nav} />
    {:else if route.name === 'player'}
      <PlayerProfile steamId={route.steamId} query={route.query || {}} origin={originHash} {nav} />
    {:else if route.name === 'compare'}
      <CompareRounds id={route.id} query={route.query || {}} {nav} />
    {:else if route.name === 'replay'}
      <!-- {#key}: Replay loads in onMount only, so a replay → replay
           jump (same route, different id — a saved filter for another
           match) must remount it or meta/positions/engine stay on the
           previous match. Query-only changes keep the component. -->
      {#key route.id}
        <Replay id={route.id} query={route.query || {}} {nav} />
      {/key}
    {:else if route.name === 'builder'}
      <Builder {nav} />
    {:else if route.name === 'sql'}
      <SqlConsole {nav} />
    {:else if route.name === 'profiles'}
      <Profiles {nav} />
    {:else if route.name === 'explorer'}
      <Explorer {nav} routeId={route.id || 0} />
    {:else if route.name === 'reports'}
      <Reports {nav} routeId={route.id || 0} />
    {:else if route.name === 'settings'}
      <Settings />
    {/if}
  </main>
  <CommandPalette {nav} />
  <MapPackPrompt bind:this={mapPackPrompt} />
</div>
