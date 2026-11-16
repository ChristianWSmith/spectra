// strings/utility.js — Utility view chrome (damage/blind-time charts,
// the consolidated throw log, per-throw rows)
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
  damagePerRoundHeading: 'Utility damage per round',
  noDamage: 'No utility damage in this selection.',
  barsLabel: 'Team utility damage per round',
  roundTitlePrefix: 'Round ',
  damageSuffix: ' damage',
  badgeComputed: 'computed',
  damageTitle: 'total damage in the current filter, by thrower team',
  maxPrefix: 'max ',
  maxSuffix: ' dmg/round · totals of recorded damage',
  // The blind-time chart (C8) — the damage chart's twin over the stored
  // per-throw blind milliseconds. The label is the HONEST semantics of
  // that total: it is NOT enemy-gated (any blind the throw applied
  // counts; the enemy-only gate applies to the affected COUNTS), which
  // is why the wording matches the shipped util_flash_ms metric doc.
  flashPerRoundHeading: 'Blind time per round',
  noFlashTime: 'No blind time in this selection.',
  flashBarsLabel: 'Team blind time per round',
  flashSuffix: ' blind time',
  flashMaxSuffix: ' blind/round · totals of recorded blind time',
  flashTitle: 'total blind time from this team\'s flashes, by thrower team',
  inferredTitle: 'calculated from the demo\'s blind events',
  badgeInferred: 'inferred',
  // The consolidated throw log (C7): ONE card at the bottom carrying the
  // filters, the live count and the single line of per-round toggles.
  throwLogHeading: 'Throw log',
  toggleTitle: 'show or hide this round\'s throws',
  noRoundShown: 'Turn on a round above to see its throws.',
  noGrenades: 'No grenades match the current filters.',
  openProfile: 'Open {name} profile',
  tickTitle: 'tick {tick} — time into round {round}',
  damageDealtTitle: 'damage dealt',
  blindTimeTitle: 'total blind time',
  affectedTitle: 'affected players (blinded or damaged by this throw)',
  watchThrowFallback: 'Watch this throw in the replay',
  coordTitle: 'detonation world coordinates',
};
