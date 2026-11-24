<script>
  // Cross-match player profile (PRD §5.13). This is the surface around the
  // Profile component: the header (back button, name, Steam id, the player
  // picker) and the profile load stay hardcoded here. The body is the builtin
  // Profile component (lib/builtins/profile/ProfileView.svelte), mounted in its
  // own frame with the player as its read-only context (04 §3, ruling 34).
  import { getProfile, listPlayers, errText } from '../services.js';
  import { profileBackTarget } from '../nav.js';
  import { listedPlayers } from '../players.js';
  import ComponentFrame from '../components/ComponentFrame.svelte';
  import SurfaceView from '../components/SurfaceView.svelte';
  import SuggestInput from '../components/SuggestInput.svelte';
  import ProfileView from '../builtins/profile/ProfileView.svelte';
  import * as S from '../strings/index.js';
  import { seed, remember } from '../viewstate.svelte.js';
  import LoadBox from '../components/LoadBox.svelte';

  // query is the route's own (?back= origin for the return trip).
  // profileBackTarget (lib/nav.js) resolves it.
  let { steamId = null, query = {}, nav = () => {} } = $props();

  let profile = $state(null);
  let profileError = $state('');

  // Player picker: every player in the library (listPlayers('') — the
  // same source the Profiles view and the Library's player facet use),
  // fetched once and filtered client-side by SuggestInput, which owns the
  // dropdown, the keyboard and the dismissal. Picking navigates to the
  // canonical /player/:steamid view. The finder's query is view-local state
  // that restores across navigation (viewstate.svelte.js).
  const finderSeed = seed('player', { q: '' });
  let q = $state(finderSeed.q);
  $effect(() => remember('player', { q }));
  let players = $state([]);

  $effect(() => {
    let live = true;
    listPlayers('')
      .then((rows) => {
        if (live) players = listedPlayers(rows) || [];
      })
      .catch(() => {});
    return () => (live = false);
  });

  // One generation per profile read: a stale result never lands.
  let profileGen = 0;

  // The profile read (mount AND profileError's Retry): the body goes back to
  // "Loading…" for the flight, so a retry never leaves a stale failure on screen.
  // The profile is never cleared on a switch: the profile subtree (its panels)
  // stays mounted, and each panel shows its own loading state while the new
  // player's data arrives. The header shows only the profile of this player.
  function loadProfile() {
    const sid = steamId;
    const my = ++profileGen;
    profileError = '';
    if (!sid) return;
    getProfile(sid)
      .then((p) => {
        if (my !== profileGen) return;
        profile = p;
        profileError = p ? '' : 'Profile not found.';
      })
      .catch((e) => {
        if (my === profileGen) profileError = errText(e);
      });
  }

  $effect(() => {
    loadProfile();
  });

  function pick(steam) {
    q = '';
    nav(`/player/${steam}`);
  }

  // The Profile component's context: the player, no match or round.
  const profileContext = $derived({ matchId: null, steamId, round: null });
  // The profile the header names: this player's, once it has loaded.
  const shownProfile = $derived(profile && profile.steamId === steamId ? profile : null);

  // Return trip: where the button points, and how to name it (the default
  // target is the Profiles list, so the label names it; anything else is
  // simply "Back").
  const backHash = $derived(profileBackTarget(query));
  const backLabel = $derived(backHash === '/profiles' ? 'Profiles' : 'Back');
</script>

<div class="view">
  <header class="view-header prof-head">
    <button class="btn" onclick={() => nav(backHash)}>
      <span class="codicon codicon-arrow-left"></span>
      {backLabel}
    </button>
    {#if shownProfile}
      <h1 class="prof-name">{shownProfile.name || '—'}</h1>
      <span class="mono muted">{shownProfile.steamId}</span>
    {:else}
      <h1>{S.profiles.h1Player}</h1>
    {/if}
    <div class="spacer"></div>
    <label class="sr-only" for="prof-q">Search players</label>
    <SuggestInput
      id="prof-q"
      wrapClass="prof-picker"
      ariaLabel="Search players"
      items={players}
      kind="player"
      align="end"
      bind:value={q}
      onselect={(p) => pick(p.steamId)}
    />
  </header>

  {#if profileError}
    <p class="error" role="alert">
      {profileError}
      <button class="btn small" onclick={loadProfile}>{S.profiles.retry}</button>
    </p>
  {/if}

  {#if steamId && !profileError}
    <!-- The Profile view: the placed component(s) when the user has used one as
         their profile view, else the default Profile component. It mounts with
         the player, so the panels hold their place while the profile loads, and
         it leaves with a failed profile read (the error line stands instead). -->
    <SurfaceView surface="profile-view" context={profileContext} {nav}>
      {#snippet fallback()}
        <ComponentFrame component={ProfileView} context={profileContext} {nav} />
      {/snippet}
    </SurfaceView>
  {:else if !profileError}
    <!-- No player yet: the profile's space is held and spins until one is chosen and its profile arrives. -->
    <LoadBox tag="div" class="prof-hold" busy name="profile-view" key=""></LoadBox>
  {/if}
</div>
