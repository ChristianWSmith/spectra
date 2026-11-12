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
  import { arbitrate, captureScroll, scrollTopFor } from './lib/viewstate.svelte.js';
  import { listMatchesPage, listJobs } from './lib/services.js';

  // Hand-rolled hash router: the route table (parseHash) lives in
  // lib/router.js with its own tests; this component owns the hashchange
  // wiring and the view switch. The initial parse is a plain const so
  // both seeds below read it once (no state_referenced_locally noise).
  const firstRoute = parseHash(location.hash);

  // Boot-warm the Library's first paint — the loading ladder's rung 1
  // (PRODUCT.md "### Defaults": pre-load what the user will plausibly ask
  // for next). This is the earliest hook that knows the FIRST route (main.js
  // mounts App before any view), so when it is the Library the exact reads
  // that view's mount fires start right here: the first match-list window
  // (200 = store.ListMatchesPageSize, the same window Library asks for —
  // carrying the route query's facets, the same seeds Library starts from,
  // so the warm key is the key ITS first fetch builds) and the job list.
  // Both are cachedRead in services.js, so Library's mount awaits these
  // SAME in-flight promises — one IPC round trip, not two — and the cache
  // flushes on every spectra:* data event like the rest. Fire-and-forget:
  // a failure never blocks boot (the view still issues its own reads and
  // surfaces its own errors), and every library-changed / job-* event
  // invalidates before the view refetches, so a warm entry can never be
  // served past a change.
  if (firstRoute.name === 'library') {
    const q = firstRoute.query || {};
    listMatchesPage('', 'extracted_at', true, 0, 200, {
      map: String(q.map || ''),
      player: String(q.player || ''),
    }).catch(() => {});
    listJobs().catch(() => {});
  }

  let route = $state(firstRoute);
  // Replay keep-alive (mini-player dock) — App OWNS the instance record:
  // {id, hash} while a Replay component is mounted (scope + transition in
  // lib/keepalive.js, pure and unit-tested), null when none. The record
  // is updated in the hashchange handler BEFORE `route` flips (one flush),
  // so the mount condition below can never observe an out-of-scope record.
  // It lives in $state only — no persistent store (sessionStorage /
  // localStorage stay forbidden); the one sanctioned module-scoped
  // view-state exception is the process-scoped registry
  // (lib/viewstate.svelte.js) — non-nav state, process-lifetime only.
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

  // Displaced-view overlay (the "replay on top, nothing beneath is
  // destroyed" rule): while the replay route is expanded, the view the
  // user was on when the dock expanded (?back= — path AND query ride it:
  // backOrigin copies the whole live hash, expandReplayHash stamps it,
  // parseHash re-splits on the first ?) stays MOUNTED beneath the overlay
  // instead of being destroyed by the chain's branch transition.
  //
  // THE INVARIANT THAT MAKES THIS WORK: at expand, `back` IS the hash
  // that was just rendering — parseHash('/' + back) yields the same
  // branch with the same props the live route had one tick ago, so the
  // {#if} chain below never swaps branches and the instance never
  // remounts; at minimize, goBack() navigates to '/' + back — exactly
  // the string parsed here — so the identical parse lands and the
  // displaced instance simply BECOMES the live route view (same branch,
  // same props, still no remount). Off-replay, viewRoute === route (the
  // chain is byte-identical to today); replay WITHOUT ?back (palette
  // jumps, hand-edited links) → null → the {#if viewRoute} guard renders
  // nothing beneath = today's behavior (minimize then falls back to
  // goBack's /match/:id, which mounts fresh). The degenerate
  // back=replay/… parses to a replay route and hits the chain's replay
  // branch (renders nothing) — by construction, never a special case.
  const displaced = $derived(
    route.name === 'replay' && route.query?.back ? parseHash('/' + route.query.back) : null,
  );
  const viewRoute = $derived(route.name === 'replay' ? displaced : route);

  // .content scroll — per-view position across navigation
  // (viewstate.svelte.js): App owns the scroll container, so the LEAVE
  // capture happens in the hashchange handler below — while the
  // outgoing view is still the rendered one — and the ENTER restore in
  // this effect, after the incoming view's DOM is in. arbitrate() is
  // the pure (prev, route) → next decision: SAME view → keep (the
  // position carries untouched — a match tab hop or a query-only change
  // never re-scrolls, exactly as today), another view → restore ITS
  // stored top (0 the first time), boot → nothing (the browser's own
  // first paint is left alone). The key is view-level (scrollKey in
  // viewstate.svelte.js), so scroll of A never applies to B.
  let contentEl = $state(null);
  // {key, top} of the view being left. Deliberately non-reactive: it is
  // written only in the hashchange handler, always together with
  // `route = next`, so the effect below re-runs on every navigation
  // anyway (same one-flush discipline as the keep-alive record above).
  let scrollRec = null;
  $effect(() => {
    const r = viewRoute;
    const content = contentEl;
    if (!content || !scrollRec) return; // boot: no view has been left yet
    const next = arbitrate(scrollRec, r);
    if (!next || next.keep) return;
    content.scrollTop = scrollTopFor(next.key);
  });

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

  // Focus management for the displaced-view overlay — Dialog.svelte's
  // restoreTo pattern: expanding captures document.activeElement and
  // moves focus ONTO the overlay container (tabindex -1 while expanded —
  // the wrapper's dynamic tabindex below), so a keyboard user lands on
  // the replay; minimize/close hands focus back — ONLY when the captured
  // element survived the trip (still connected — a preserved view's
  // button does, an unmounted one doesn't) AND focus was not deliberately
  // moved elsewhere (still on/inside the overlay, or dropped to body by
  // its teardown; a sidebar click meanwhile is respected — the sidebar is
  // interactive BY DESIGN while the overlay covers only the content
  // area). preventScroll on both legs: neither the move nor the restore
  // may scroll the preserved .content underneath. No focus trap beyond
  // that — the overlay is a landing point, not a modal.
  let keepAliveEl = $state(null); // the .rp-keepalive wrapper (the overlay container)

  $effect(() => {
    if (!replayActive) return;
    const overlay = keepAliveEl;
    const prev = document.activeElement;
    overlay?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      const focusStillOnOverlay =
        !active ||
        active === document.body ||
        active === document.documentElement ||
        active === overlay ||
        !!overlay?.contains(active);
      if (
        focusStillOnOverlay &&
        prev &&
        prev !== document.body &&
        prev !== document.documentElement &&
        prev !== active &&
        prev.isConnected &&
        typeof prev.focus === 'function'
      ) {
        prev.focus({ preventScroll: true });
      }
    };
  });

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
      // Scroll capture FIRST — viewRoute still reads the outgoing view
      // (route has not flipped yet), and .content still holds its
      // position: record it under the outgoing view's key so the effect
      // above can restore the INCOMING view's own position after the
      // chain re-renders (one flush, same discipline as `alive` below).
      scrollRec = captureScroll(viewRoute, contentEl ? contentEl.scrollTop : 0);
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
  <main class="content" bind:this={contentEl}>
    <!-- Replay keep-alive (mini-player dock): rendered OUTSIDE the view
         chain so it can coexist with the match view. The wrapper has
         three states: display:contents while active (the layout is
         byte-for-byte the pre-keep-alive one — .replay-view stays
         .content's direct child); a FIXED OVERLAY over the content area
         while active AND expanded over a preserved view (.rp-keepalive-cover
         — the displaced-view overlay, see viewRoute above; the preserved
         view stays mounted + inert beneath it); and a fixed bottom-right
         panel while collapsed (its own .rp-keepalive CSS in style.css;
         dialogs at z-60 stay above it). The WHOLE collapsed panel is the
         expand target (role=button + click/key) — expandReplay above is
         the one path. {#key alive.id} keeps the old {#key route.id}
         remount rule: same id → never remount (query changes ride the
         replayQuery prop); a different id destroys the instance and
         fresh-loads; alive → null unmounts it (cleanup runs as before). -->
    {#if alive}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (both ends are
           DYNAMIC through ternaries the compiler cannot pair up: while
           collapsed this element is the dock's role=button with
           tabindex 0; while expanded it is the overlay container with
           tabindex -1 and NO role — the focus target the $effect above
           lands on. The ignore covers the expanded, role-less case.) -->
      <div
        class="rp-keepalive"
        class:rp-keepalive-cover={replayActive}
        class:rp-keepalive-mini={!replayActive}
        bind:this={keepAliveEl}
        role={!replayActive ? 'button' : undefined}
        tabindex={replayActive ? -1 : 0}
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
    <!-- The view chain's HOST: a plain block (layout-neutral — verified
         against style.css: there are NO `.content >` direct-child or
         :first-child/:last-child selectors, and .view's centering is
         width-based, so a full-width wrapper between .content and the
         views changes nothing), holding the chain so the expanded replay
         can keep the displaced view MOUNTED beneath its overlay and
         INERT (viewRoute/inert above — the property is what both WebView
         targets reflect; the sidebar is OUTSIDE .content, hence outside
         this host, hence interactive by design). inert flips with
         replayActive: the overlay is up ⟺ nothing beneath is reachable. -->
    <div class="app-views" inert={replayActive}>
      {#if viewRoute}
        {#if viewRoute.name === 'library'}
          <Library {nav} query={viewRoute.query || {}} />
        {:else if viewRoute.name === 'match'}
          <Match id={viewRoute.id} routeTab={viewRoute.tab || ''} {nav} expandReplay={matchExpand} />
        {:else if viewRoute.name === 'round'}
          <RoundDetail id={viewRoute.id} round={viewRoute.round} query={viewRoute.query || {}} {nav} />
        {:else if viewRoute.name === 'player'}
          <PlayerProfile steamId={viewRoute.steamId} query={viewRoute.query || {}} origin={originHash} {nav} />
        {:else if viewRoute.name === 'compare'}
          <CompareRounds id={viewRoute.id} query={viewRoute.query || {}} {nav} />
        {:else if viewRoute.name === 'replay'}
          <!-- Replay renders ABOVE (the keep-alive block), outside this
               chain: it must survive into same-id match routes as the
               mini-player dock. Mount/destroy is keyed by the alive record
               (id), so a replay → replay jump for another id remounts it and
               any out-of-scope route destroys it — the same rules the old
               in-chain {#key route.id} gave, plus the cross-route keep-alive.
               This branch ALSO catches the degenerate hand-edited
               back=replay/… (viewRoute = the parsed back → replay): renders
               nothing beneath the overlay, exactly like a replay route with
               no back. -->
        {:else if viewRoute.name === 'builder'}
          <Builder {nav} />
        {:else if viewRoute.name === 'sql'}
          <SqlConsole {nav} />
        {:else if viewRoute.name === 'profiles'}
          <Profiles {nav} />
        {:else if viewRoute.name === 'explorer'}
          <Explorer {nav} routeId={viewRoute.id || 0} />
        {:else if viewRoute.name === 'reports'}
          <Reports {nav} routeId={viewRoute.id || 0} />
        {:else if viewRoute.name === 'settings'}
          <Settings />
        {/if}
      {/if}
    </div>
  </main>
  <CommandPalette {nav} />
  <MapPackPrompt bind:this={mapPackPrompt} />
</div>
