<script>
  // The Profile component (builtin): the player's panels, composed. It reads
  // nothing itself: each panel reads the context it inherits (steamId) through
  // its own read API. The header, the player picker and the profile load stay
  // hardcoded in the surface (PlayerProfile.svelte).
  let { spectra } = $props();
</script>

<spectra.Child name="profile-career" />
<spectra.Child name="profile-trend" />
<div class="prof-splits">
  <spectra.Child name="profile-sides" />
  <spectra.Child name="profile-maps" />
  <spectra.Child name="profile-weapons" />
</div>
<spectra.Child name="profile-history" />
