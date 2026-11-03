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
  import CommandPalette from './lib/components/CommandPalette.svelte';
  import MapPackPrompt from './lib/components/MapPackPrompt.svelte';
  import PlayerProfile from './lib/views/PlayerProfile.svelte';
  import CompareRounds from './lib/views/CompareRounds.svelte';
  import { parseHash } from './lib/router.js';

  // Hand-rolled hash router: the route table (parseHash) lives in
  // lib/router.js with its own tests; this component owns the hashchange
  // wiring, the legacy-hash canonicalize() rewrite and the view switch.
  let route = $state(parseHash(location.hash));
  let mapPackPrompt = $state(null); // MapPackPrompt instance (bind:this)

  // Rewrite a legacy #/timeline/:id hash to its canonical
  // #/match/:id/timeline form (same-document navigation — the hashchange
  // it fires re-parses to the same route without the legacy flag).
  function canonicalize() {
    if (route.legacy) location.replace(`#/match/${route.id}/timeline`);
  }

  onMount(() => {
    const onChange = () => {
      route = parseHash(location.hash);
      canonicalize();
    };
    canonicalize();
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
  <nav class="sidebar">
    <div class="brand">
      <img src="/wails.png" alt="" width="22" height="22" />
      <span class="brand-name">spectra</span>
    </div>
    <button
      class="nav-item"
      class:active={route.name === 'library' ||
        route.name === 'match' ||
        route.name === 'round' ||
        route.name === 'replay' ||
        route.name === 'player' ||
        route.name === 'compare'}
      onclick={() => nav('/library')}
    >
      Library
    </button>
    <button
      class="nav-item"
      class:active={route.name === 'settings'}
      onclick={() => nav('/settings')}
    >
      Settings
    </button>
    <button
      class="nav-item"
      class:active={route.name === 'builder'}
      onclick={() => nav('/builder')}
    >
      Builder
    </button>
    <button
      class="nav-item"
      class:active={route.name === 'sql'}
      onclick={() => nav('/sql')}
    >
      SQL console
    </button>
    <button
      class="nav-item"
      class:active={route.name === 'explorer'}
      onclick={() => nav('/explorer')}
    >
      Explorer
    </button>
    <button
      class="nav-item"
      class:active={route.name === 'reports'}
      onclick={() => nav('/reports')}
    >
      Reports
    </button>
    <div class="spacer"></div>
  </nav>
  <main class="content">
    {#if route.name === 'library'}
      <Library {nav} />
    {:else if route.name === 'match'}
      <Match id={route.id} routeTab={route.tab || ''} {nav} />
    {:else if route.name === 'round'}
      <RoundDetail id={route.id} round={route.round} {nav} />
    {:else if route.name === 'player'}
      <PlayerProfile steamId={route.steamId} {nav} />
    {:else if route.name === 'compare'}
      <CompareRounds id={route.id} {nav} />
    {:else if route.name === 'replay'}
      <Replay id={route.id} {nav} />
    {:else if route.name === 'builder'}
      <Builder {nav} />
    {:else if route.name === 'sql'}
      <SqlConsole {nav} />
    {:else if route.name === 'explorer'}
      <Explorer {nav} />
    {:else if route.name === 'reports'}
      <Reports {nav} />
    {:else if route.name === 'settings'}
      <Settings />
    {/if}
  </main>
  <CommandPalette {nav} />
  <MapPackPrompt bind:this={mapPackPrompt} />
</div>
