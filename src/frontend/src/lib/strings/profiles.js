// strings/profiles.js — Profiles list chrome (header, count, empty
// states, table headers)
// Extracted from views/Profiles.svelte (Strings Stage 3, Sweep-B);
// values are plain strings with {arg} placeholders.
// Audit: node --test src/lib/strings-audit.test.js   (from frontend/)

export const profiles = {
  title: 'Profiles',
  subtitle: 'Every player in the library — click a row for their profile.',
  playerSuffix: ' player',
  retry: 'Retry',
  adrErrorLead: 'ADR unavailable: ',
  dismissAdrError: 'Dismiss ADR error',
  loadingDetail: 'Loading players…',
  noPlayers: 'No players yet',
  noPlayersHint: 'Players appear here once matches are imported.',
  noMatchPrefix: 'No players match “',
  tryDifferentName: 'Try a different name.',
  thPlayer: 'Player',
  thMatches: 'Matches',
  thAdr: 'ADR',
  thLastImport: 'Last import',
};
