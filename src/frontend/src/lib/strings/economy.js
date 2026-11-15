// strings/economy.js — Economy view chrome (EconCurve head, summary
// cards, buy-types table)
// Extracted from views/Economy.svelte (Strings Stage 3, Sweep-B); values
// are plain strings with {arg} placeholders — compose at the call site
// with S.fill(S.economy.slot, { arg }).
// Audit: node --test src/lib/strings-audit.test.js   (from frontend/)

export const economy = {
  // head / alerts
  dismissError: 'Dismiss error',
  loadingDetail: 'Loading economy…',
  roundSuffix: ' round',
  headNote: 'buy types follow saved rules — click a chip for the reason',

  // summary stat cards (label + sub + drill tooltip formula)
  pistolLabel: 'Pistol → next round',
  pistolSub: 'pistol wins held next round',
  pistolTitle: 'Formula: pistol rounds won by a side where that side also won the immediately following round ÷ pistol rounds won. Click: watch round {round} in the replay (the round\'s own span, start→end).',
  forceLabel: 'Force-buy win rate',
  noForceBuys: 'no force buys',
  forceTitle: 'Formula: force-buy rounds won by a team ÷ that team\'s own force-buy rounds, attributed per team across the halftime side switch. Click: watch round {round} in the replay (start→end).',
  gapLabel: 'Winner equipment value advantage',
  gapSub: 'avg winner − loser equip per round',
  gapTitle: 'Formula: average across decided rounds of (winner equipment value − loser equipment value) at freeze time end — never this round\'s spend. Click: watch round {round} (largest gap) in the replay.',
  lostLabel: 'Lost equipment',
  lostTitle: 'Formula: total across decided rounds of the losing team\'s freeze-end equipment value — inferred: assumes the losing side\'s gear was destroyed. Click: watch round {round} in the replay.',

  // provenance chips
  badgeComputed: 'computed',
  badgeInferred: 'inferred',
  inferredTitle: 'calculated from the round results',

  // buy-types table
  buyTypesHeading: 'Buy types',
  noBuyTypes: 'No buy types recorded yet.',
  thWinner: 'Winner',
  thCTBuy: 'CT buy',
  thTBuy: 'T buy',
  thEquipCT: 'Equip CT',
  thEquipT: 'Equip T',
  thLossCT: 'Loss CT',
  thLossT: 'Loss T',
  openRound: 'Open round {round}',
  chipTitle: '{why} (rules v{rule}) — click for full text',
  noExplanation: 'no explanation recorded',
  rulesV: 'rules v',
  closeExplanation: 'Close explanation',
  tableNote: 'Equip CT/T = freeze-end gear held (never this round\'s spend); Net worth = that plus unspent money; Loss CT/T = the bonus that side would collect for losing ($1400→$3400 by $500, half +1).',
  tableNoteTail:
    'on the Loss headers\n          marks those values as calculated from the round results rather than\n          recorded.',
};
