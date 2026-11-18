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
  loadingPlayersDetail: 'Loading players…',
  noPlayers: 'No players yet',
  noPlayersHint: 'Players appear here once matches are imported.',
  noMatchPrefix: 'No players match “',
  tryDifferentName: 'Try a different name.',
  thPlayer: 'Player',
  thMatches: 'Matches',
  thAdr: 'ADR',
  thLastImport: 'Last import',

  // PlayerProfile — the profile surface (career metrics, trend, splits
  // and match history). The fixed cards' LABELS are not chrome copy:
  // they are metricorder data (metric titles, read through
  // composedSequence) — W13b retired statMatchesLabel / statWinPctLabel
  // as their second home, and the unification of 2026-11-18 retired the
  // two statTitle tooltips with their raw-card branches (every card is a
  // metric tile now: its `labelTitle` carries the seed's own doc).
  h1Player: 'Player',
  careerErrorLead: 'Profile metrics unavailable: ',
  trendHeading: 'Trend',
  // The trend card's metric picker (the shared SuggestInput): the one
  // place a metric NAME is chosen for the sparkline.
  trendMetricSearch: 'Search metrics…',
  trendMetricAria: 'Trend metric',
  trendAriaLead: ' trend across ',
  trendAriaTail: ' matches',
  openMatchDot: 'Open match — {title}',
  sparkMinLead: ' matches · min ',
  sparkMaxLead: ' · max ',
  sparkFootnote: '· x = sequence (patch order → import order within a patch) · click a dot to open the match',
  onlyOneMatch: 'Only one match so far — the trend line needs at least two.',
  noTrendData: 'No trend data for this stat yet.',
  sidesHeading: 'Sides',
  thSide: 'Side',
  thRounds: 'Rounds',
  thWinPct: 'Win%',
  thKast: 'KAST',
  noSides: 'No CT/T breakdown yet.',
  mapsHeading: 'Maps',
  thMap: 'Map',
  thWins: 'Wins',
  openMapTitle: 'Open {map} matches for this player in the Library',
  noMaps: 'No per-map breakdown yet.',
  weaponsPrefix: 'Weapons ',
  topPrefix: '(top ',
  thWeapon: 'Weapon',
  thKills: 'Kills',
  thDamage: 'Damage',
  noWeapons: 'No weapon rows.',
  matchHistoryPrefix: 'Match history ',
  mostRecentFirst: '(most recent first)',
  importedTitle: 'Import date of the demo — CS2 demos record no played time',
  thImported: 'Imported',
  thResult: 'Result',
  thScore: 'Score',
  thStartingSide: 'Starting side',
  thKastPct: 'KAST%',
  openMatchRow: 'Open match {id}',
  startSideTitle: 'Side the player started the match on',
  noHistory: 'No matches yet.',
  loadingDetail: 'Loading…',
};
