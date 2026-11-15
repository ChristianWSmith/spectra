// strings/compare.js — CompareRounds view chrome (header, column
// headings, loadout summary, actions)
// Extracted from views/CompareRounds.svelte (Strings Stage 3, Sweep-B);
// values are plain strings with {arg} placeholders — compose at the call
// site with S.fill(S.compare.slot, { arg }).
// Audit: node --test src/lib/strings-audit.test.js   (from frontend/)

export const compare = {
  back: ' Back',
  title: 'Compare rounds',
  roundsSelected: ' rounds selected',
  dismissError: 'Dismiss error',
  emptyLead: 'No rounds selected. Open the match\'s ',
  emptyRounds: 'Rounds',
  emptyMid: ' tab, tick\n        two to four rounds (max 4), then press ',
  emptyCompare: 'Compare',
  backToMatch: ' Back to match',
  loadingRounds: 'Loading rounds…',
  roundLabel: 'Round ',
  winReasonTitle: 'Round win reason',
  classTitle: '{explanation} (rules v{ruleVersion})',
  roundNotFound: 'Round not found.',
  economyHeading: 'Economy',
  thEquip: 'Equip',
  thMoney: 'Money',
  thSpent: 'Spent',
  buyCT: 'buy CT ',
  loadoutHeading: 'Loadout summary',
  killsLabel: 'Kills',
  firstBloodLabel: 'First blood',
  openProfile: 'Open {name} profile',
  killed: 'killed',
  bombSiteLabel: 'Bomb site',
  mvpLabel: 'MVP',
  utilityHeading: 'Utility',
  eventSequence: 'Event sequence ',
  noEvents: 'No events.',
  replayStartTitle: 'Replay from the round start ({tick})',
  replayStartLabel: 'Replay from the round start',
  roundDetail: 'Round detail',
};
