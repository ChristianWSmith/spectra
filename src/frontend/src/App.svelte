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
  import { NAV_ACTIONS, expandReplayHash } from './lib/nav.js';
  import { nextReplayAlive, backOrigin } from './lib/keepalive.js';

  // Hand-rolled hash router: the route table (parseHash) lives in
  // lib/router.js with its own tests; this component owns the hashchange
  // wiring and the view switch. The initial parse is a plain const so
  // both seeds below read it once (no state_referenced_locally noise).
  const firstRoute = parseHash(location.hash);
  let route = $state(firstRoute);
  // Replay keep-alive (mini-player dock) — App OWNS the instance record:
  // {id, hash} while a Replay component is mounted (scope + transition in
  // lib/keepalive.js, pure and unit-tested), null when none. The record
  // is updated in the hashchange handler BEFORE `route` flips (one flush),
  // so the mount condition below can never observe an out-of-scope record.
  // It lives in $state only — no sessionStorage / module-global store.
  let alive = $state(nextReplayAlive(null, firstRoute, location.hash));
  // In-app origin for views that return "where you came from":
  // PlayerProfile's back button resolves it through profileBackTarget
  // (lib/nav.js). Recorded on every hashchange — the hash BEFORE the
  // current one — so it is empty until the first navigation.
  let originHash = $state('');
  let lastHash = location.hash;
  let mapPackPrompt = $state(null); // MapPackPrompt instance (bind:this)

  // Keep-alive activation: true only while the ROUTE is the replay view
  // (the record is non-null only in scope, so route.name alone decides).
  // Deactivating (→ same-id match route) collapses Replay into the dock;
  // activating restores it. Replay reads this as its `active` prop.
  const replayActive = $derived(!!alive && route.name === 'replay');
  // The query Replay consumes: taken from the CAPTURED replay hash —
  // while active it equals the live route query; while collapsed it stays
  // frozen at the last replay state (filter/scope/loop context), never the
  // match route's query (which would reset the filter to defaults).
  const replayQuery = $derived(alive ? parseHash(alive.hash).query || {} : {});

  // expandReplay — THE expand path of the dock (both triggers go through
  // it: the mini-panel's click below, and Match's header "Watch replay"
  // via the expandReplay prop — see Match.svelte). One navigation:
  // the captured replay hash with ?back= rewritten to the LATEST match
  // path (keepalive.backOrigin), so the return trip out of the expanded
  // replay (the Minimize cell, and Close before its teardown) lands on
  // the tab the user was actually on. Never replayHash() here: that is
  // the FRESH-entry builder and would reset the live query state.
  function expandReplay() {
    if (!alive || route.name === 'replay') return; // no instance / already expanded
    nav(expandReplayHash(alive.hash, backOrigin(location.hash)));
  }

  // The header-button flavor: null while no same-id instance is alive
  // (Match then falls back to its fresh-entry replayHash exactly as today).
  const matchExpand = $derived(
    alive && alive.id === route.id && route.name === 'match' ? expandReplay : null,
  );

  // Keyboard activation of the collapsed dock (Enter/Space — input.js's
  // window keys are inert while inactive, so Space cannot double-fire).
  function onDockKey(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      expandReplay();
    }
  }

  // closeReplay — THE teardown path, shared by BOTH Close affordances:
  // the dock panel's X (rendered only while collapsed) and Replay's
  // topbar Close cell — which receives this exact handler as its
  // onClose prop (that cell exits to the back origin via goBack FIRST,
  // then lands here; never forked). Destroy the kept-alive instance:
  // `alive = null` unmounts the whole {#if alive} wrapper, so Replay's
  // own cleanup runs exactly as it does
  // for any out-of-scope route — the component and its engine/renderer
  // memory are gone — and the user stays on whatever match route they are
  // on. The next replay navigation then mounts FRESH (the header's
  // "Watch replay" falls back to replayHash as if no instance ever
  // existed).
  // stopPropagation FIRST: the whole wrapper is the expand target (its
  // click handler and onDockKey ride the div), so this click must never
  // bubble into expandReplay — and the paired onDockCloseKey below stops
  // the Enter/Space keydown that activates the focused BUTTON, whose own
  // default click then lands here (close, never expand).
  function closeReplay(e) {
    e.stopPropagation();
    alive = null;
  }

  function onDockCloseKey(e) {
    e.stopPropagation(); // no preventDefault: the button's own click should still fire
  }

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
      const next = parseHash(location.hash);
      // Keep-alive FIRST (same flush as `route` below): replay routes
      // create/refresh the captured hash, same-id match routes keep the
      // record (hash frozen), everything else drops it → unmount.
      alive = nextReplayAlive(alive, next, location.hash);
      route = next;
    };
    window.addEventListener('hashchange', onChange);

    // CS2 asset-extraction prompt: presence-driven — MapPackPrompt
    // fetches the three asset statuses itself and opens whenever any
    // family is missing (every launch; "Not now" is session-only).
    // Never throws, never blocks startup.
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
    <img class="sidebar-mark" src="/wails.png" alt="Spectra" width="30" height="30" />
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
    <!-- Replay keep-alive (mini-player dock): rendered OUTSIDE the view
         chain so it can coexist with the match view. The wrapper is
         display:contents while active (the layout is byte-for-byte the
         pre-keep-alive one — .replay-view stays .content's direct child)
         and a fixed bottom-right panel while collapsed (its own .rp-keepalive
         CSS in style.css; dialogs at z-60 stay above it). The WHOLE
         collapsed panel is the expand target (role=button + click/key) —
         expandReplay above is the one path. {#key alive.id} keeps the old
         {#key route.id} remount rule: same id → never remount (query
         changes ride the replayQuery prop); a different id destroys the
         instance and fresh-loads; alive → null unmounts it (cleanup runs
         as before). -->
    {#if alive}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (the dock's
           role=button is DYNAMIC — it exists exactly when tabindex does:
           the collapsed panel is a button, the full replay view is not.
           The compiler cannot see the pairing through the ternary.) -->
      <div
        class="rp-keepalive"
        class:rp-keepalive-mini={!replayActive}
        role={!replayActive ? 'button' : undefined}
        tabindex={!replayActive ? 0 : undefined}
        aria-label={!replayActive ? 'Expand replay' : undefined}
        title={!replayActive ? 'Expand replay' : undefined}
        onclick={replayActive ? null : expandReplay}
        onkeydown={replayActive ? null : onDockKey}
      >
        {#key alive.id}
          <Replay id={alive.id} query={replayQuery} active={replayActive} {nav} onClose={closeReplay} />
        {/key}
        {#if !replayActive}
          <!-- Close (X): the panel's TOP-RIGHT corner, collapsed state
               ONLY — the full replay view's single way out is its Back
               button, so this can never appear there. It sits inside
               the expand target above, hence the stopPropagation pair
               (closeReplay / onDockCloseKey): a click or Enter/Space on
               the X closes the instance and NEVER also expands it. -->
          <button
            type="button"
            class="btn rp-keepalive-close"
            aria-label="Close replay"
            title="Close the replay — it reloads when reopened"
            onclick={closeReplay}
            onkeydown={onDockCloseKey}
          >
            <span class="codicon codicon-close" aria-hidden="true"></span>
          </button>
        {/if}
      </div>
    {/if}
    {#if route.name === 'library'}
      <Library {nav} query={route.query || {}} />
    {:else if route.name === 'match'}
      <Match id={route.id} routeTab={route.tab || ''} {nav} expandReplay={matchExpand} />
    {:else if route.name === 'round'}
      <RoundDetail id={route.id} round={route.round} query={route.query || {}} {nav} />
    {:else if route.name === 'player'}
      <PlayerProfile steamId={route.steamId} query={route.query || {}} origin={originHash} {nav} />
    {:else if route.name === 'compare'}
      <CompareRounds id={route.id} query={route.query || {}} {nav} />
    {:else if route.name === 'replay'}
      <!-- Replay renders ABOVE (the keep-alive block), outside this
           chain: it must survive into same-id match routes as the
           mini-player dock. Mount/destroy is keyed by the alive record
           (id), so a replay → replay jump for another id remounts it and
           any out-of-scope route destroys it — the same rules the old
           in-chain {#key route.id} gave, plus the cross-route keep-alive. -->
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
