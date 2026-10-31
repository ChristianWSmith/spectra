<script>
  import { onMount } from 'svelte';
  import { AppService } from '../bindings/github.com/ChristianWSmith/spectra';
  import Library from './lib/views/Library.svelte';
  import Match from './lib/views/Match.svelte';
  import RoundDetail from './lib/views/RoundDetail.svelte';
  import Timeline from './lib/views/Timeline.svelte';
  import Settings from './lib/views/Settings.svelte';

  // Hand-rolled hash router (M1 plan §4): deep-navigable URLs without a
  // router dependency.
  //   #/library
  //   #/match/:id
  //   #/match/:id/round/:n
  //   #/timeline/:id
  //   #/settings
  let route = $state(parseHash(location.hash));

  function parseHash(hash) {
    const h = hash.replace(/^#/, '') || '/library';
    let m = h.match(/^\/match\/(\d+)\/round\/(\d+)$/);
    if (m) return { name: 'round', id: Number(m[1]), round: Number(m[2]) };
    m = h.match(/^\/match\/(\d+)$/);
    if (m) return { name: 'match', id: Number(m[1]) };
    m = h.match(/^\/timeline\/(\d+)$/);
    if (m) return { name: 'timeline', id: Number(m[1]) };
    if (h.startsWith('/settings')) return { name: 'settings' };
    return { name: 'library' };
  }

  onMount(() => {
    const onChange = () => (route = parseHash(location.hash));
    window.addEventListener('hashchange', onChange);

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
        route.name === 'timeline'}
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
    <div class="spacer"></div>
  </nav>
  <main class="content">
    {#if route.name === 'library'}
      <Library {nav} />
    {:else if route.name === 'match'}
      <Match id={route.id} {nav} />
    {:else if route.name === 'round'}
      <RoundDetail id={route.id} round={route.round} {nav} />
    {:else if route.name === 'timeline'}
      <Timeline id={route.id} {nav} />
    {:else if route.name === 'settings'}
      <Settings />
    {/if}
  </main>
</div>
