<script>
  import { onMount } from 'svelte';
  import { AppService } from '../bindings/github.com/ChristianWSmith/spectra';
  import Library from './lib/views/Library.svelte';
  import Match from './lib/views/Match.svelte';
  import RoundDetail from './lib/views/RoundDetail.svelte';
  import Timeline from './lib/views/Timeline.svelte';
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

  // Hand-rolled hash router: deep-navigable URLs without a
  // router dependency.
  //   #/library
  //   #/match/:id
  //   #/match/:id/round/:n
  //   #/timeline/:id
  //   #/replay/:id
  //   #/settings
  let route = $state(parseHash(location.hash));
  let mapPackPrompt = $state(null); // MapPackPrompt instance (bind:this)

  function parseHash(hash) {
    const h = hash.replace(/^#/, '') || '/library';
    // Round numbers can be negative (knife/warmup rounds carry negative
    // indices — see extract's renumber), so the round segment allows "-?".
    let m = h.match(/^\/match\/(\d+)\/round\/(-?\d+)$/);
    if (m) return { name: 'round', id: Number(m[1]), round: Number(m[2]) };
    m = h.match(/^\/match\/(\d+)$/);
    if (m) return { name: 'match', id: Number(m[1]) };
    m = h.match(/^\/player\/(\d{17})$/);
    if (m) return { name: 'player', steamId: m[1] };
    m = h.match(/^\/compare\/(\d+)$/);
    if (m) return { name: 'compare', id: Number(m[1]) };
    m = h.match(/^\/timeline\/(\d+)$/);
    if (m) return { name: 'timeline', id: Number(m[1]) };
    m = h.match(/^\/replay\/(\d+)$/);
    if (m) return { name: 'replay', id: Number(m[1]) };
    if (h.startsWith('/builder')) return { name: 'builder' };
    if (h.startsWith('/sql')) return { name: 'sql' };
    if (h.startsWith('/explorer')) return { name: 'explorer' };
    if (h.startsWith('/reports')) return { name: 'reports' };
    if (h.startsWith('/settings')) return { name: 'settings' };
    return { name: 'library' };
  }

  onMount(() => {
    const onChange = () => (route = parseHash(location.hash));
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
        route.name === 'timeline' ||
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
      <Match id={route.id} {nav} />
    {:else if route.name === 'round'}
      <RoundDetail id={route.id} round={route.round} {nav} />
    {:else if route.name === 'player'}
      <PlayerProfile steamId={route.steamId} {nav} />
    {:else if route.name === 'compare'}
      <CompareRounds id={route.id} {nav} />
    {:else if route.name === 'timeline'}
      <Timeline id={route.id} {nav} />
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
