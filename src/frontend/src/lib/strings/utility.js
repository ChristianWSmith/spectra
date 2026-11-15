// strings/utility.js — Utility view chrome (filters, damage/flash
// panels, per-throw rows)
// Extracted from views/Utility.svelte (Strings Stage 3, Sweep-B); values
// are plain strings with {arg} placeholders — compose at the call site
// with S.fill(S.utility.slot, { arg }).
// Audit: node --test src/lib/strings-audit.test.js   (from frontend/)

export const utility = {
  dismissError: 'Dismiss error',
  loadingDetail: 'Loading utility events…',
  kindLabel: 'Kind',
  allKinds: 'All kinds',
  throwerLabel: 'Thrower',
  allPlayers: 'All players',
  grenadeSuffix: ' grenade',
  hint: '▶ seeks to the throw (±10 s loop) · camera follows the thrower',
  damagePerRoundHeading: 'Utility damage per round',
  noDamage: 'No utility damage in this selection.',
  barsLabel: 'Team utility damage per round',
  roundTitlePrefix: 'Round ',
  damageSuffix: ' damage',
  badgeComputed: 'computed',
  damageTitle: 'total damage in the current filter, by thrower team',
  maxPrefix: 'max ',
  maxSuffix: ' dmg/round · totals of recorded damage',
  flashHeading: 'Flash effectiveness',
  flashCellTitle: 'total blind time and affected players from this team\'s flashes, in the current filter',
  blindsSuffix: ' blinds',
  affectedSuffix: ' affected',
  inferredTitle: 'calculated from the demo\'s blind events',
  badgeInferred: 'inferred',
  flashNote: 'total blind time + affected players, by thrower team',
  noGrenades: 'No grenades match the current filters.',
  groupTitlePrefix: 'Round ',
  roundDamageTitle: 'team damage in this round, from the throws in the current filter',
  dmgSuffix: ' dmg',
  openProfile: 'Open {name} profile',
  tickTitle: 'tick {tick} — time into round {round}',
  damageDealtTitle: 'damage dealt',
  blindTimeTitle: 'total blind time',
  affectedTitle: 'affected players (blinded or damaged by this throw)',
  watchThrowFallback: 'Watch this throw in the replay',
  coordTitle: 'detonation world coordinates',
};
