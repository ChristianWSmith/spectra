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
  import StatusChip from '../components/StatusChip.svelte';
  import ProfileView from '../builtins/profile/ProfileView.svelte';
  import * as S from '../strings/index.js';
  import { seed, remember } from '../viewstate.svelte.js';

  // query is the route's own (?back= origin for the return trip);
  // origin is the hash the app navigated from — App records it on
  // hashchange. profileBackTarget (lib/nav.js) resolves both.
  let { steamId = null, query = {}, origin = '', nav = () => {} } = $props();

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
  function loadProfile() {
    const sid = steamId;
    const my = ++profileGen;
    profile = null;
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

  // Return trip: where the button points, and how to name it (the default
  // target is the Profiles list, so the label names it; anything else is
  // simply "Back").
  const backHash = $derived(profileBackTarget(query, origin));
  const backLabel = $derived(backHash === '/profiles' ? 'Profiles' : 'Back');
</script>

<div class="view">
  <header class="view-header prof-head">
    <button class="btn" onclick={() => nav(backHash)}>
      <span class="codicon codicon-arrow-left"></span>
      {backLabel}
    </button>
    {#if profile}
      <h1 class="prof-name">{profile.name || '—'}</h1>
      <span class="mono muted">{profile.steamId}</span>
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

  {#if profile}
    <!-- The Profile view: the placed component(s) when the user has used one as
         their profile view, else the default Profile component. -->
    <SurfaceView surface="profile-view" context={profileContext} {nav}>
      {#snippet fallback()}
        <ComponentFrame component={ProfileView} context={profileContext} {nav} />
      {/snippet}
    </SurfaceView>
  {:else if !profileError}
    <p class="muted" role="status"><StatusChip block detail={S.profiles.loadingDetail} /></p>
  {/if}
</div>
